/**
 * Parses merchant credit alerts into the shape PaymentRegistry.ingest() expects.
 *
 * A bank or wallet alert is the only signal a merchant gets that a QR payment landed. It carries
 * no order id, so the amount does the matching (see payments.js) — but eSewa's alert also carries
 * an RRN, a unique reference for the transaction. That is worth more than it looks: it lets the
 * caller drop a duplicate without guessing. Phones retry, forwarding apps resend, and a settled
 * tab must not be settled twice by the same rupees arriving twice.
 *
 * Written against real SMS from two issuers:
 *
 *   eSewa  Rs. 540.00 received From 9845369898 for RRN SG5YXWTC66U, Re:Others: dd/FonepayQR
 *   NMB    Transaction success for Rs.1800 from 974****310 via Fonepay QR for RRN 95ZJSVUE631
 *
 * Every bank on the Fonepay network words its own alert, so a parser that only knows the senders
 * it has samples for will drop real credits from the rest. What the samples share is an amount and
 * an `RRN <token>`; that pair is the fallback, reported as source 'unknown' so a caller can treat a
 * shape-matched alert more carefully than one matched by a pattern written against a real message.
 *
 * Settlement notices are deliberately NOT parsed. NMB sends one when the day's takings land
 * ("A/C 1#19 deposited NPR 1,800.00 on 28/08/2026"): same money, arriving a second time as a
 * batch, and carrying no RRN. Requiring an RRN is what keeps those out — treating one as a payment
 * would settle a tab that was already settled.
 */

/**
 * Alerts we know how to read, tried in order. Add a pattern per sender as real
 * samples arrive; anything still unmatched falls through to GENERIC below.
 *
 * Payer is `[\d*xX]` rather than `\d`, because some issuers mask the middle of
 * the number (NMB sends 974****310). Masked digits still identify a payer well
 * enough to eyeball, and refusing to parse the whole message over them loses
 * the amount and RRN too.
 */
const PATTERNS = [
  {
    source: 'esewa',
    // "Rs. 540.00 received From 9845369898 for RRN SG5YXWTC66U, Re:Others: dd/FonepayQR"
    re: /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+received\s+From\s+([\d*xX]{6,15})(?:\s+for\s+RRN\s+([A-Za-z0-9]+))?/i,
    map: (m) => ({ amount: m[1], payer: m[2], reference: m[3] }),
  },
  {
    source: 'nmb',
    // "Transaction success for Rs.1800 from 974****310 via Fonepay QR for RRN 95ZJSVUE631"
    re: /Transaction\s+success\s+for\s+(?:Rs\.?|NPR)\s*([\d,]+(?:\.\d{1,2})?)\s+from\s+([\d*xX]{6,15})(?:\s+via\s+(.+?))?\s+for\s+RRN\s+([A-Za-z0-9]+)/i,
    map: (m) => ({ amount: m[1], payer: m[2], channel: m[3], reference: m[4] }),
  },
];

/**
 * Last resort for an issuer we have never seen.
 *
 * Every Fonepay credit alert observed so far carries an amount and an
 * `RRN <token>`, whatever words surround them. Requiring BOTH is what makes
 * this safe to guess with: an amount alone would match a settlement sweep like
 * "A/C 1#19 deposited NPR 1,800.00", which is the same money arriving a second
 * time as a batch. Settling a tab against that would close a bill twice.
 *
 * So: no RRN, no parse. A settlement notice has none, and correctly falls
 * through to null.
 */
const GENERIC = {
  amount: /(?:Rs\.?|NPR|NRs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i,
  reference: /\bRRN[:\s]+([A-Za-z0-9]{4,})/i,
  payer: /\bfrom\s+([\d*xX]{6,15})/i,
};

/**
 * Which rail the money came in on. eSewa puts it after its `Re:<remark>:`
 * prefix; NMB writes "via Fonepay QR". Fall back to spotting a Fonepay
 * mention anywhere, so an unfamiliar wording still reports something.
 */
function extractChannel(text, fromPattern) {
  if (fromPattern) return fromPattern.trim();
  const esewaStyle = /Re:[^:]*:\s*([^\s,]+)/i.exec(text)?.[1];
  if (esewaStyle) return esewaStyle;
  const via = /\bvia\s+([A-Za-z][\w\s]*?(?:QR|wallet|transfer))\b/i.exec(text)?.[1];
  if (via) return via.trim();
  return /fonepay/i.test(text) ? 'FonepayQR' : undefined;
}

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

    return {
      amount,
      payer: fields.payer,
      reference: fields.reference, // RRN: unique per transaction, use it to reject duplicates
      channel: extractChannel(text, fields.channel),
      source,
      at,
      raw: text.trim(),
    };
  }

  // Unknown issuer. Every bank on the network words its alert differently, and
  // returning null for all of them means a real credit is dropped in silence —
  // a customer paid and the tab stays open. An amount plus an RRN is enough to
  // act on; `source: 'unknown'` marks it as read by shape rather than by a
  // pattern written against a real sample, so a caller can flag it for review.
  const amount = toAmount(GENERIC.amount.exec(text)?.[1]);
  const reference = GENERIC.reference.exec(text)?.[1];
  if (amount !== null && reference) {
    return {
      amount,
      payer: GENERIC.payer.exec(text)?.[1],
      reference,
      channel: extractChannel(text),
      source: 'unknown',
      at,
      raw: text.trim(),
    };
  }

  return null;
}

/** True when the alert is one we can act on. */
export const isCredit = (text) => parseAlert(text) !== null;
