import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaymentRegistry, toPaisa } from '../src/payments.js';
import { makeStaticQR } from '../src/fixture.js';
import { decode } from '../src/qr.js';

const merchantQR = makeStaticQR();

function registry(options = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const reg = new PaymentRegistry({ merchantQR, clock, ...options });
  return { reg, advance: (ms) => (now += ms), at: () => now };
}

test('toPaisa avoids float drift', () => {
  assert.equal(toPaisa(450.37), 45037);
  assert.equal(toPaisa('450.37'), 45037);
  assert.equal(toPaisa(0.29), 29);
  assert.equal(toPaisa(1.1), 110);
  assert.equal(toPaisa('1.1'), 110);
  assert.throws(() => toPaisa('12.345'), /bad amount/);
});

test('open produces a QR carrying the requested amount', () => {
  const { reg } = registry();
  const payment = reg.open({ tabId: 'tab-1', amount: 450 });

  assert.equal(payment.requestedAmount, '450.00');
  assert.equal(payment.surplusPaisa, 0);
  assert.equal(decode(payment.qr).amount, 450);
  assert.equal(decode(payment.qr).initiation, 'dynamic');
});

test('reference and bill number reach tag 62', () => {
  const { reg } = registry();
  const payment = reg.open({
    tabId: 'tab-1',
    amount: 450,
    reference: 'ORDER-88',
    billNumber: 'TAB-1042',
  });

  const { additional } = decode(payment.qr);
  assert.equal(additional['Reference Label'], 'ORDER-88');
  assert.equal(additional['Bill Number'], 'TAB-1042');
});

test('concurrent identical amounts get distinct paisa', () => {
  const { reg } = registry();
  const payments = Array.from({ length: 20 }, (_, i) =>
    reg.open({ tabId: `tab-${i}`, amount: 450 })
  );

  const amounts = new Set(payments.map((p) => p.requestedPaisa));
  assert.equal(amounts.size, 20, 'every open payment must have a unique amount');

  // The first one keeps the clean number.
  assert.equal(payments[0].requestedPaisa, 45000);
  for (const p of payments.slice(1)) {
    assert.ok(p.surplusPaisa >= 1 && p.surplusPaisa <= 99);
  }
});

test('different bases that could collide still resolve uniquely', () => {
  const { reg } = registry();
  const a = reg.open({ tabId: 'a', amount: 450.5 });
  const b = reg.open({ tabId: 'b', amount: 450.5 });
  const c = reg.open({ tabId: 'c', amount: 450 });

  const amounts = new Set([a, b, c].map((p) => p.requestedPaisa));
  assert.equal(amounts.size, 3);
});

test('a matching credit settles exactly one payment', () => {
  const { reg } = registry();
  const first = reg.open({ tabId: 'tab-1', amount: 450 });
  const second = reg.open({ tabId: 'tab-2', amount: 450 });

  const events = [];
  reg.on('settled', (e) => events.push(e));

  const result = reg.ingest({ amount: second.requestedAmount, raw: 'SMS text' });

  assert.equal(result.status, 'settled');
  assert.equal(result.payment.tabId, 'tab-2');
  assert.equal(events.length, 1);

  // The other one is untouched and still pending.
  assert.deepEqual(
    reg.pending.map((p) => p.id),
    [first.id]
  );
});

test('an unrecognised credit is reported, never guessed at', () => {
  const { reg } = registry();
  reg.open({ tabId: 'tab-1', amount: 450 });

  const seen = [];
  reg.on('unmatched', (e) => seen.push(e));

  const result = reg.ingest({ amount: 999, raw: 'someone paid an old tab' });

  assert.equal(result.status, 'unmatched');
  assert.equal(seen.length, 1);
  assert.equal(reg.pending.length, 1);
});

test("strategy 'none' flags ambiguity instead of settling the wrong tab", () => {
  const { reg } = registry({ strategy: 'none' });
  reg.open({ tabId: 'tab-1', amount: 450 });
  reg.open({ tabId: 'tab-2', amount: 450 });

  const result = reg.ingest({ amount: 450 });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.equal(reg.pending.length, 2, 'nothing may be settled while ambiguous');
});

test("strategy 'none' requests the exact amount", () => {
  const { reg } = registry({ strategy: 'none' });
  const payment = reg.open({ tabId: 'tab-1', amount: 450 });
  assert.equal(payment.requestedPaisa, 45000);
  assert.equal(payment.surplusPaisa, 0);
});

test('payments expire and free their amount slot', () => {
  const { reg, advance } = registry({ ttlMs: 60_000 });
  const expired = [];
  reg.on('expired', (p) => expired.push(p));

  const first = reg.open({ tabId: 'tab-1', amount: 450 });
  advance(60_001);

  const second = reg.open({ tabId: 'tab-2', amount: 450 });

  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, first.id);
  assert.equal(second.requestedPaisa, 45000, 'clean amount is reusable once freed');
});

test('a credit arriving after expiry does not settle anything', () => {
  const { reg, advance } = registry({ ttlMs: 60_000 });
  const payment = reg.open({ tabId: 'tab-1', amount: 450 });

  advance(60_001);
  const result = reg.ingest({ amount: payment.requestedAmount });

  assert.equal(result.status, 'unmatched');
});

test('manual confirmation is recorded as manual', () => {
  const { reg } = registry();
  const payment = reg.open({ tabId: 'tab-1', amount: 450 });

  const settled = reg.confirmManually(payment.id, { by: 'bartender-2' });

  assert.equal(settled.manual, true);
  assert.equal(settled.confirmedBy, 'bartender-2');
  assert.equal(reg.pending.length, 0);
  assert.throws(() => reg.confirmManually(payment.id), /no pending payment/);
});

test('cancel removes a payment and frees its slot', () => {
  const { reg } = registry();
  const payment = reg.open({ tabId: 'tab-1', amount: 450 });

  assert.equal(reg.cancel(payment.id).id, payment.id);
  assert.equal(reg.pending.length, 0);
  assert.equal(reg.cancel(payment.id), null);
});

test('splitting a tab opens independent payments', () => {
  const { reg } = registry();
  const a = reg.open({ tabId: 'tab-9', amount: 300, reference: 'split-1' });
  const b = reg.open({ tabId: 'tab-9', amount: 300, reference: 'split-2' });

  assert.notEqual(a.requestedPaisa, b.requestedPaisa);

  reg.ingest({ amount: a.requestedAmount });
  assert.deepEqual(
    reg.pending.map((p) => p.id),
    [b.id]
  );
});

test('rejects bad input at the door', () => {
  const { reg } = registry();
  assert.throws(() => reg.open({ tabId: 'x', amount: 0 }), /positive/);
  assert.throws(() => reg.open({ amount: 100 }), /tabId is required/);
  assert.throws(() => new PaymentRegistry({}), /merchantQR is required/);
  assert.throws(
    () => new PaymentRegistry({ merchantQR, strategy: 'wat' }),
    /unknown strategy/
  );
});
