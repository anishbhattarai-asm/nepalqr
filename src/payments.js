import { EventEmitter } from 'node:events';
import { withAmount } from './qr.js';

/**
 * Tracks in-flight QR payments and matches incoming bank credits against them.
 *
 * The problem this solves: a bank credit alert tells you an amount and a time,
 * nothing else. There is no order id in it. So the amount itself has to be the
 * identifier, which means no two open payments may share one.
 *
 * Strategy 'paisa' adds 0-99 paisa to each request so concurrent payments are
 * distinguishable — the last-call case where eight people all owe Rs. 450.
 * Offsets are allocated by checking the live set of open amounts, so there are
 * zero collisions until 100 payments are open at once.
 *
 * Strategy 'none' requests the exact amount. Use it if the wallet apps turn out
 * to mishandle paisa. Concurrent equal amounts then resolve to 'ambiguous'
 * rather than settling the wrong tab.
 *
 * All money is handled as integer paisa. No floats anywhere near a balance.
 */

const MAX_PAISA_OFFSET = 100;

export function toPaisa(rupees) {
  if (typeof rupees === 'number') {
    if (!Number.isFinite(rupees)) throw new Error(`bad amount ${rupees}`);
    return Math.round(rupees * 100);
  }
  if (typeof rupees === 'string') {
    if (!/^\d+(\.\d{1,2})?$/.test(rupees)) throw new Error(`bad amount "${rupees}"`);
    const [whole, frac = ''] = rupees.split('.');
    return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  }
  throw new Error(`bad amount ${rupees}`);
}

export function toRupees(paisa) {
  return paisa / 100;
}

function formatPaisa(paisa) {
  return (paisa / 100).toFixed(2);
}

let counter = 0;
function nextId() {
  counter += 1;
  return `pay_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export class PaymentRegistry extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.merchantQR   the merchant's static QR payload
   * @param {number} [options.ttlMs=180000]  how long a QR stays matchable
   * @param {'paisa'|'none'} [options.strategy='paisa']
   * @param {() => number} [options.clock]  injectable for tests
   */
  constructor({ merchantQR, ttlMs = 180_000, strategy = 'paisa', clock = Date.now } = {}) {
    super();
    if (!merchantQR) throw new Error('merchantQR is required');
    if (strategy !== 'paisa' && strategy !== 'none') {
      throw new Error(`unknown strategy "${strategy}"`);
    }

    this.merchantQR = merchantQR;
    this.ttlMs = ttlMs;
    this.strategy = strategy;
    this.clock = clock;

    /** @type {Map<string, object>} id -> payment */
    this._payments = new Map();
    this._sweepTimer = null;
  }

  /** Payments still awaiting a matching credit. */
  get pending() {
    this.sweep();
    return [...this._payments.values()];
  }

  get(id) {
    return this._payments.get(id) ?? null;
  }

  _openAmounts() {
    return new Set([...this._payments.values()].map((p) => p.requestedPaisa));
  }

  _allocate(basePaisa) {
    if (this.strategy === 'none') return basePaisa;

    const taken = this._openAmounts();

    // Prefer the exact amount — a clean number is less confusing to the payer.
    if (!taken.has(basePaisa)) return basePaisa;

    const offsets = [];
    for (let i = 1; i < MAX_PAISA_OFFSET; i++) offsets.push(i);
    for (let i = offsets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
    }

    for (const offset of offsets) {
      if (!taken.has(basePaisa + offset)) return basePaisa + offset;
    }

    throw new Error(
      `all ${MAX_PAISA_OFFSET} paisa slots around Rs. ${formatPaisa(basePaisa)} are in ` +
        'use; too many identical concurrent payments'
    );
  }

  /**
   * Open a payment and produce the QR to show the customer.
   *
   * @param {object} input
   * @param {string} input.tabId
   * @param {number|string} input.amount  what the tab actually owes, in rupees
   * @param {string} [input.reference]    -> tag 62.05
   * @param {string} [input.billNumber]   -> tag 62.01
   * @returns {{id, tabId, tabPaisa, requestedPaisa, requestedAmount, surplusPaisa, qr, openedAt, expiresAt}}
   */
  open({ tabId, amount, reference, billNumber }) {
    if (!tabId) throw new Error('tabId is required');
    this.sweep();

    const tabPaisa = toPaisa(amount);
    if (tabPaisa <= 0) throw new Error('amount must be positive');

    const requestedPaisa = this._allocate(tabPaisa);
    const requestedAmount = formatPaisa(requestedPaisa);
    const now = this.clock();

    const payment = {
      id: nextId(),
      tabId,
      tabPaisa,
      requestedPaisa,
      requestedAmount,
      surplusPaisa: requestedPaisa - tabPaisa,
      qr: withAmount(this.merchantQR, requestedAmount, {
        billNumber,
        referenceLabel: reference,
      }),
      openedAt: now,
      expiresAt: now + this.ttlMs,
    };

    this._payments.set(payment.id, payment);
    this.emit('opened', payment);
    return payment;
  }

  /**
   * Feed in a credit from whatever bank alert source you have.
   *
   * @param {object} credit
   * @param {number|string} credit.amount  rupees credited
   * @param {number} [credit.at]           epoch ms; defaults to now
   * @param {string} [credit.raw]          original alert text, kept for audit
   * @param {string} [credit.source]
   * @returns {{status:'settled'|'ambiguous'|'unmatched', payment?, candidates?}}
   */
  ingest(credit) {
    this.sweep();

    const paisa = toPaisa(credit.amount);
    const at = credit.at ?? this.clock();
    const record = { ...credit, paisa, at };

    const matches = [...this._payments.values()].filter(
      (p) => p.requestedPaisa === paisa
    );

    if (matches.length === 0) {
      const result = { status: 'unmatched', credit: record };
      this.emit('unmatched', result);
      return result;
    }

    if (matches.length > 1) {
      // Only reachable under strategy 'none'. Never guess which tab — a wrong
      // settle here means one customer's payment closes another's bill.
      const result = { status: 'ambiguous', credit: record, candidates: matches };
      this.emit('ambiguous', result);
      return result;
    }

    const payment = matches[0];
    this._payments.delete(payment.id);

    const settled = { ...payment, settledAt: at, credit: record };
    const result = { status: 'settled', payment: settled, credit: record };
    this.emit('settled', result);
    return result;
  }

  /**
   * Settle by id without a bank credit — the bartender's manual override.
   * Records that no alert backed it, because that distinction matters at
   * cash-up time.
   */
  confirmManually(id, { by, note } = {}) {
    const payment = this._payments.get(id);
    if (!payment) throw new Error(`no pending payment ${id}`);

    this._payments.delete(id);
    const settled = {
      ...payment,
      settledAt: this.clock(),
      manual: true,
      confirmedBy: by ?? null,
      note: note ?? null,
    };
    this.emit('settled', { status: 'settled', payment: settled, manual: true });
    return settled;
  }

  cancel(id, reason = 'cancelled') {
    const payment = this._payments.get(id);
    if (!payment) return null;
    this._payments.delete(id);
    this.emit('cancelled', { payment, reason });
    return payment;
  }

  /** Drop expired payments, freeing their amount slots. */
  sweep() {
    const now = this.clock();
    for (const [id, payment] of this._payments) {
      if (payment.expiresAt <= now) {
        this._payments.delete(id);
        this.emit('expired', payment);
      }
    }
  }

  /** Optional timer so 'expired' fires promptly for the UI. */
  startSweeping(intervalMs = 5000) {
    this.stopSweeping();
    this._sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this._sweepTimer.unref?.();
    return this;
  }

  stopSweeping() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }
}
