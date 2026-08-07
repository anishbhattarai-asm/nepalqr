import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checksum, crc16 } from '../src/crc.js';
import { parseTLV, serializeTLV, setField } from '../src/tlv.js';
import {
  decode,
  detectOpaqueFields,
  validate,
  withAmount,
  withoutAmount,
} from '../src/qr.js';
import { makeFonepayQR, makeSignedStaticQR, makeStaticQR } from '../src/fixture.js';

test('crc16 matches the canonical CRC-16/CCITT-FALSE check value', () => {
  // Published check value for this polynomial/init combination. This is the
  // one assertion here that is independent of our own implementation.
  assert.equal(crc16('123456789'), 0x29b1);
  assert.equal(checksum('123456789'), '29B1');
});

test('crc16 hashes UTF-8 bytes, not UTF-16 code units', () => {
  const devanagari = crc16('नमस्ते');
  const asBytes = crc16(new TextEncoder().encode('नमस्ते'));
  assert.equal(devanagari, asBytes);
});

test('TLV round-trips byte for byte', () => {
  const payload = makeStaticQR();
  assert.equal(serializeTLV(parseTLV(payload)), payload);
});

test('TLV rejects a length that overruns the payload', () => {
  assert.throws(() => parseTLV('0099tooshort'), /only \d+ remain/);
});

test('TLV rejects a non-numeric length', () => {
  assert.throws(() => parseTLV('00XXvalue'), /bad length/);
});

test('setField inserts in ascending tag order', () => {
  const fields = [
    { tag: '00', value: '01' },
    { tag: '53', value: '524' },
    { tag: '58', value: 'NP' },
  ];
  setField(fields, '54', '450.37');
  assert.deepEqual(
    fields.map((f) => f.tag),
    ['00', '53', '54', '58']
  );
});

test('setField replaces in place without reordering', () => {
  const fields = [
    { tag: '00', value: '01' },
    { tag: '01', value: '11' },
    { tag: '53', value: '524' },
  ];
  setField(fields, '01', '12');
  assert.deepEqual(
    fields.map((f) => f.tag),
    ['00', '01', '53']
  );
  assert.equal(fields[1].value, '12');
});

test('fixtures validate against their own CRC', () => {
  assert.ok(validate(makeStaticQR()));
  assert.ok(validate(makeSignedStaticQR()));
});

test('a tampered payload fails CRC validation', () => {
  const payload = makeStaticQR();
  const tampered = payload.replace('DEMO BAR', 'DEMO CAR');
  assert.ok(!validate(tampered));
});

test('withAmount injects the amount and re-seals a valid CRC', () => {
  const staticQR = makeStaticQR();
  const dynamicQR = withAmount(staticQR, 450.37);

  assert.ok(validate(dynamicQR));

  const decoded = decode(dynamicQR);
  assert.equal(decoded.amount, 450.37);
  assert.equal(decoded.amountRaw, '450.37');
  assert.equal(decoded.initiation, 'dynamic');
  assert.equal(decoded.initiationRaw, '12');
});

test('withAmount preserves merchant identity exactly', () => {
  const staticQR = makeStaticQR({ merchantId: '1234509876543' });
  const dynamicQR = withAmount(staticQR, 450.37);

  const before = decode(staticQR);
  const after = decode(dynamicQR);

  assert.deepEqual(after.merchantAccounts, before.merchantAccounts);
  assert.equal(after.merchantName, before.merchantName);
  assert.equal(after.merchantCity, before.merchantCity);
  assert.equal(after.mcc, before.mcc);
  assert.equal(after.currency, before.currency);
});

test('amount formatting trims trailing zeros but keeps paisa', () => {
  assert.equal(decode(withAmount(makeStaticQR(), 450)).amountRaw, '450');
  assert.equal(decode(withAmount(makeStaticQR(), 450.37)).amountRaw, '450.37');
  assert.equal(decode(withAmount(makeStaticQR(), 450.3)).amountRaw, '450.3');
});

test('amount rejects zero, negatives and nonsense', () => {
  const staticQR = makeStaticQR();
  assert.throws(() => withAmount(staticQR, 0), /positive/);
  assert.throws(() => withAmount(staticQR, -5), /positive/);
  assert.throws(() => withAmount(staticQR, Number.NaN), /positive/);
  assert.throws(() => withAmount(staticQR, '12.345'), /2 decimals/);
});

test('withAmount refuses a payload whose own CRC is broken', () => {
  const broken = makeStaticQR().replace('DEMO BAR', 'DEMO CAR');
  assert.throws(() => withAmount(broken, 100), /failed its own CRC/);
  assert.ok(validate(withAmount(broken, 100, { requireValidCRC: false })));
});

test('optional reference fields land in tag 62 without losing existing subtags', () => {
  const dynamicQR = withAmount(makeStaticQR(), 450.37, {
    billNumber: 'TAB-1042',
    referenceLabel: 'ORDER-88',
  });

  const { additional } = decode(dynamicQR);
  assert.equal(additional['Bill Number'], 'TAB-1042');
  assert.equal(additional['Reference Label'], 'ORDER-88');
  assert.equal(additional['Terminal Label'], 'POS01'); // from the fixture
});

test('withoutAmount returns a dynamic QR to static form', () => {
  const staticQR = makeStaticQR();
  const restored = withoutAmount(withAmount(staticQR, 450.37));

  assert.ok(validate(restored));
  assert.equal(decode(restored).amount, null);
  assert.equal(decode(restored).initiation, 'static');
  assert.equal(restored, staticQR);
});

test('detectOpaqueFields is quiet on a clean QR', () => {
  assert.deepEqual(detectOpaqueFields(makeStaticQR()), []);
});

test('detectOpaqueFields flags a private template as high severity', () => {
  const suspects = detectOpaqueFields(makeSignedStaticQR());
  assert.ok(suspects.length > 0);
  assert.ok(suspects.some((s) => s.path === '80' && s.severity === 'high'));
});

test('detectOpaqueFields flags non-standard subtags inside tag 62', () => {
  const withOddSubtag = makeSignedStaticQR({ signatureTag: '80' });
  const fields = parseTLV(withOddSubtag);
  const additional = fields.find((f) => f.tag === '62');
  additional.value += '9924' + 'D41F8A2B77C09E5163B4A8F0'; // 24 chars, length 24

  // Re-seal so the payload is well formed before inspection.
  const resealed = (() => {
    const body =
      serializeTLV(fields.filter((f) => f.tag !== '63')) + '6304';
    return body + checksum(body);
  })();

  const suspects = detectOpaqueFields(resealed);
  assert.ok(suspects.some((s) => s.path === '62.99'));
});

test('the Fonepay-shaped fixture survives amount injection intact', () => {
  const staticQR = makeFonepayQR({ merchantId: '2222050000012345' });
  const dynamicQR = withAmount(staticQR, 450.37);

  assert.ok(validate(dynamicQR));

  const before = decode(staticQR);
  const after = decode(dynamicQR);

  assert.equal(before.merchantAccounts[0].guid, 'fonepay.com');
  assert.deepEqual(after.merchantAccounts, before.merchantAccounts);
  assert.equal(after.amount, 450.37);
  assert.equal(after.initiation, 'dynamic');
});
