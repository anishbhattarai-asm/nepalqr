/**
 * Parses merchant credit alerts into the shape PaymentRegistry.ingest() expects.
 *
 * A bank or wallet alert is the only signal a merchant gets that a QR payment landed. It carries
 * no order id, so the amount does the matching (see payments.js) — but eSewa's alert also carries
 * an RRN, a unique reference for the transaction. That is worth more than it looks: it lets the
 * caller drop a duplicate without guessing. Phones retry, forwarding apps resend, and a settled
 * tab must not be settled twice by the same rupees arriving twice.
 *
 * Written against one real eSewa SMS:
 *
 *   Rs. 540.00 received From 9800000000 for RRN SAMPLE12345, Re:Others: dd/FonepayQR
 *
 * Other alert shapes (refunds, other banks, other channels) have not been seen, so parse() returns
 * null rather than guessing when a message does not match. Unrecognised alerts should be surfaced
 * for a human, never silently dropped: a missed credit means a customer paid and the tab stayed open.
 */

/** Alerts we know how to read. Add a pattern per sender as real samples arrive. */
const PATTERNS = [
  {
    source: 'esewa',
    // "Rs. 540.00 received From 9800000000 for RRN SAMPLE12345, Re:Others: dd/FonepayQR"
    re: /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+received\s+From\s+(\d{6,15})(?:\s+for\s+RRN\s+([A-Za-z0-9]+))?/i,
    map: (m) => ({ amount: m[1], payer: m[2], reference: m[3] }),
  },
];

/** Anything that reads like money leaving rather than arriving. */
const DEBIT_HINTS = /\b(debited|paid to|sent to|withdraw|transferred to|reversal|refund)\b/i;

function toAmount(raw) {
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * @param {string} text  the raw alert body
 * @param {object} [opts]
 * @param {number} [opts.at]  epoch ms the alert arrived; defaults to now
 * @returns {{amount:number, payer?:string, reference?:string, channel?:string, source:string,
 *            at:number, raw:string} | null}
 */
export function parseAlert(text, { at = Date.now() } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // A debit alert can carry an amount that happens to match an open tab. Settling on one would
  // close a bill because the merchant spent the same sum, which is the worst kind of wrong.
  if (DEBIT_HINTS.test(text)) return null;

  for (const { source, re, map } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;

    const fields = map(m);
    const amount = toAmount(fields.amount);
    if (amount === null) return null;

    // "Re:Others: dd/FonepayQR" — which rail the money came in on, useful for reporting and for
    // telling a QR payment apart from an unrelated transfer that happens to be the same amount.
    const channel = /Re:[^:]*:\s*([^\s,]+)/i.exec(text)?.[1];

    return {
      amount,
      payer: fields.payer,
      reference: fields.reference, // RRN: unique per transaction, use it to reject duplicates
      channel,
      source,
      at,
      raw: text.trim(),
    };
  }

  return null;
}

/** True when the alert is one we can act on. */
export const isCredit = (text) => parseAlert(text) !== null;
