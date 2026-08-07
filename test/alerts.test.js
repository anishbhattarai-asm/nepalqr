import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAlert, isCredit } from '../src/alerts.js';

// The exact body of a real eSewa merchant credit SMS.
const REAL = 'Rs. 540.00 received From 9800000000 for RRN SAMPLE12345, Re:Others: dd/FonepayQR';

test('reads every field out of a real eSewa credit alert', () => {
  const a = parseAlert(REAL, { at: 1_700_000_000_000 });
  assert.equal(a.amount, 540);
  assert.equal(a.payer, '9800000000');
  assert.equal(a.reference, 'SAMPLE12345');
  assert.equal(a.channel, 'dd/FonepayQR');
  assert.equal(a.source, 'esewa');
  assert.equal(a.at, 1_700_000_000_000);
  assert.equal(a.raw, REAL);
});

test('keeps the paisa, which is what identifies the tab', () => {
  const a = parseAlert('Rs. 540.37 received From 9800000000 for RRN ABC123, Re:Others: dd/FonepayQR');
  assert.equal(a.amount, 540.37);
});

test('handles thousands separators', () => {
  assert.equal(parseAlert('Rs. 15,220.00 received From 9800000002 for RRN XYZ9').amount, 15220);
});

test('survives the line breaks an SMS arrives with', () => {
  const a = parseAlert('Rs. 540.00\nreceived\nFrom 9800000000\nfor RRN SAMPLE12345,\nRe:Others: dd/FonepayQR');
  assert.equal(a.amount, 540);
  assert.equal(a.reference, 'SAMPLE12345');
});

test('reads an alert with no RRN rather than failing', () => {
  const a = parseAlert('Rs. 200.00 received From 9800000001');
  assert.equal(a.amount, 200);
  assert.equal(a.reference, undefined);
});

test('ignores debit alerts, even when the amount would match an open tab', () => {
  assert.equal(parseAlert('Rs. 540.00 debited From your account'), null);
  assert.equal(parseAlert('Rs. 540.00 paid to Some Merchant Store'), null);
  assert.equal(parseAlert('Rs. 540.00 refund received From 9800000000'), null);
});

test('returns null on anything it does not recognise, instead of guessing', () => {
  assert.equal(parseAlert('Your OTP is 540123'), null);
  assert.equal(parseAlert('Balance: Rs. 540.00'), null);
  assert.equal(parseAlert(''), null);
  assert.equal(parseAlert(null), null);
  assert.equal(parseAlert(undefined), null);
});

test('rejects a zero or negative amount', () => {
  assert.equal(parseAlert('Rs. 0.00 received From 9800000000'), null);
});

test('isCredit is a thin yes/no over the same rules', () => {
  assert.equal(isCredit(REAL), true);
  assert.equal(isCredit('Rs. 540.00 debited From your account'), false);
});

test('the RRN is what makes a duplicate forward detectable', () => {
  // the same SMS delivered twice, as a retrying forwarder would
  const first = parseAlert(REAL);
  const second = parseAlert(REAL);
  assert.equal(first.reference, second.reference);
  assert.ok(first.reference, 'without a reference, a duplicate is indistinguishable from a second payment');
});
