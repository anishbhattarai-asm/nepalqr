import { checksum } from './crc.js';
import {
  findField,
  getValue,
  pad2,
  parseTLV,
  parseTree,
  removeField,
  serializeTLV,
  setField,
} from './tlv.js';
import {
  ADDITIONAL_DATA_TAGS,
  CURRENCIES,
  POINT_OF_INITIATION,
  describeMerchantAccountTag,
  describeTag,
} from './tags.js';

const CRC_TAG = '63';
const AMOUNT_TAG = '54';
const INITIATION_TAG = '01';
const ADDITIONAL_DATA_TAG = '62';

const STATIC = '11';
const DYNAMIC = '12';

/** Split a payload into its body and the CRC the issuer put on it. */
function splitCRC(payload) {
  const marker = payload.lastIndexOf('6304');
  if (marker === -1 || marker + 8 !== payload.length) {
    throw new Error('payload does not end with a tag-63 CRC field');
  }
  return {
    body: payload.slice(0, marker + 4), // includes the literal "6304"
    crc: payload.slice(marker + 4),
  };
}

/** Does the payload's own CRC check out? */
export function validate(payload) {
  try {
    const { body, crc } = splitCRC(payload);
    return checksum(body) === crc.toUpperCase();
  } catch {
    return false;
  }
}

/** Append a freshly computed tag 63 to a body that has none. */
export function seal(fields) {
  const body = serializeTLV(fields) + '6304';
  return body + checksum(body);
}

function formatAmount(amount) {
  if (typeof amount === 'string') {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      throw new Error(`amount "${amount}" must be digits with up to 2 decimals`);
    }
    return amount;
  }

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`amount must be a positive finite number, got ${amount}`);
  }

  // Trim trailing zeros: 450 stays "450", 450.37 stays "450.37".
  const text = amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (text.length > 13) {
    throw new Error(`amount "${text}" exceeds the 13 character limit`);
  }
  return text;
}

/**
 * The core operation: take a merchant's static QR and produce a dynamic one
 * carrying a transaction amount.
 *
 * Merchant identity (tags 26-51) is copied through untouched — only the
 * amount, the initiation method, and the CRC change.
 *
 * @param {string} payload    A static merchant QR payload.
 * @param {number|string} amount
 * @param {object} [options]
 * @param {string} [options.billNumber]     -> tag 62.01
 * @param {string} [options.referenceLabel] -> tag 62.05
 * @param {string} [options.terminalLabel]  -> tag 62.07
 * @param {boolean} [options.requireValidCRC=true]
 *        Refuse to modify a payload whose own CRC is already wrong — that
 *        usually means a bad scan, and re-sealing it would hide the damage.
 */
export function withAmount(payload, amount, options = {}) {
  const { requireValidCRC = true } = options;

  if (requireValidCRC && !validate(payload)) {
    throw new Error(
      'source QR failed its own CRC check — likely a misread scan. ' +
        'Pass { requireValidCRC: false } to override.'
    );
  }

  const fields = parseTLV(payload);
  removeField(fields, CRC_TAG);

  setField(fields, INITIATION_TAG, DYNAMIC);
  setField(fields, AMOUNT_TAG, formatAmount(amount));

  const extras = [
    ['01', options.billNumber],
    ['05', options.referenceLabel],
    ['07', options.terminalLabel],
  ].filter(([, value]) => value != null && value !== '');

  if (extras.length > 0) {
    const current = findField(fields, ADDITIONAL_DATA_TAG);
    const subfields = current ? parseTLV(current.value) : [];
    for (const [subtag, value] of extras) setField(subfields, subtag, String(value));
    setField(fields, ADDITIONAL_DATA_TAG, serializeTLV(subfields));
  }

  return seal(fields);
}

/** Strip the amount back out, returning the QR to reusable static form. */
export function withoutAmount(payload) {
  const fields = parseTLV(payload);
  removeField(fields, CRC_TAG);
  removeField(fields, AMOUNT_TAG);
  setField(fields, INITIATION_TAG, STATIC);
  return seal(fields);
}

/** Semantic view of a payload. */
export function decode(payload) {
  const fields = parseTLV(payload);
  const initiation = getValue(fields, INITIATION_TAG);
  const currency = getValue(fields, '53');
  const amount = getValue(fields, AMOUNT_TAG);

  const accounts = fields
    .filter((f) => Number(f.tag) >= 26 && Number(f.tag) <= 51)
    .map((f) => {
      let guid = null;
      try {
        guid = getValue(parseTLV(f.value), '00') ?? null;
      } catch {
        /* opaque value; leave guid null */
      }
      return { tag: f.tag, guid, raw: f.value };
    });

  const additional = {};
  const additionalField = findField(fields, ADDITIONAL_DATA_TAG);
  if (additionalField) {
    try {
      for (const sub of parseTLV(additionalField.value)) {
        const name = ADDITIONAL_DATA_TAGS[sub.tag] ?? `Unknown (${sub.tag})`;
        additional[name] = sub.value;
      }
    } catch {
      additional.raw = additionalField.value;
    }
  }

  return {
    formatVersion: getValue(fields, '00'),
    initiation: initiation === DYNAMIC ? 'dynamic' : 'static',
    initiationRaw: initiation,
    merchantAccounts: accounts,
    mcc: getValue(fields, '52'),
    currency,
    currencyCode: CURRENCIES[Number(currency)] ?? null,
    amount: amount == null ? null : Number(amount),
    amountRaw: amount ?? null,
    country: getValue(fields, '58'),
    merchantName: getValue(fields, '59'),
    merchantCity: getValue(fields, '60'),
    postalCode: getValue(fields, '61'),
    additional,
    crc: getValue(fields, CRC_TAG),
    crcValid: validate(payload),
  };
}

/**
 * Flag fields that could be issuer-side integrity data.
 *
 * This is THE question for anyone modifying a merchant QR. The tag-63 CRC is
 * only an error-detecting checksum and we can always recompute it. But if the
 * acquirer additionally embeds a MAC or hash over the payload, editing the
 * amount will fail validation on their side and no amount of client-side code
 * will fix it.
 *
 * Heuristics, in rough order of how suspicious they are:
 *   - private templates (80-99), which EMVCo leaves entirely to the issuer
 *   - tag 62 subtags outside the standard 01-09
 *   - long hex or base64-looking values anywhere
 *
 * A clean report is encouraging but not proof. Only a live scan settles it.
 */
export function detectOpaqueFields(payload) {
  const suspects = [];

  const looksEncoded = (value) =>
    (/^[0-9A-Fa-f]{16,}$/.test(value) || /^[A-Za-z0-9+/=_-]{24,}$/.test(value)) &&
    !/^\d+$/.test(value);

  const walk = (fields, path) => {
    for (const field of fields) {
      const here = [...path, field.tag];
      const dotted = here.join('.');
      const tagNumber = Number(field.tag);

      if (path.length === 0 && tagNumber >= 80 && tagNumber <= 99) {
        suspects.push({
          path: dotted,
          value: field.value,
          reason: 'private template (tags 80-99) — contents defined by the issuer',
          severity: 'high',
        });
      }

      if (
        path.length === 1 &&
        path[0] === ADDITIONAL_DATA_TAG &&
        !ADDITIONAL_DATA_TAGS[field.tag]
      ) {
        suspects.push({
          path: dotted,
          value: field.value,
          reason: 'non-standard subtag inside Additional Data (62)',
          severity: 'high',
        });
      }

      if (looksEncoded(field.value) && !field.children) {
        suspects.push({
          path: dotted,
          value: field.value,
          reason: `${field.value.length} chars of hex/base64-looking data`,
          severity: 'medium',
        });
      }

      if (field.children) walk(field.children, here);
    }
  };

  walk(parseTree(payload), []);
  return suspects;
}

/** Human-readable dump. Use this on the first real merchant QR you get hold of. */
export function inspect(payload) {
  const lines = [];
  const tree = parseTree(payload);

  const render = (fields, depth, parentTag = null) => {
    for (const field of fields) {
      const indent = '  '.repeat(depth);
      const parentNumber = parentTag == null ? null : Number(parentTag);

      let label;
      if (depth === 0) {
        label = describeTag(field.tag);
      } else if (parentTag === ADDITIONAL_DATA_TAG) {
        label = ADDITIONAL_DATA_TAGS[field.tag] ?? `Non-standard (${field.tag})`;
      } else if (parentNumber >= 26 && parentNumber <= 51) {
        label = describeMerchantAccountTag(field.tag);
      } else {
        label = describeTag(field.tag);
      }

      let annotation = '';
      if (depth === 0 && field.tag === INITIATION_TAG) {
        annotation = ` <- ${POINT_OF_INITIATION[Number(field.value)] ?? '?'}`;
      }
      if (depth === 0 && field.tag === '53') {
        annotation = ` <- ${CURRENCIES[Number(field.value)] ?? 'unknown currency'}`;
      }

      lines.push(
        `${indent}${field.tag} ${pad2(field.value.length)}  ${label.padEnd(38)} ${
          field.children ? '' : field.value
        }${annotation}`
      );

      if (field.children) render(field.children, depth + 1, field.tag);
    }
  };

  render(tree, 0);

  const ok = validate(payload);
  lines.push('');
  lines.push(`CRC: ${ok ? 'valid' : 'INVALID — this payload is corrupt or misread'}`);

  const suspects = detectOpaqueFields(payload);
  lines.push('');

  if (suspects.length === 0) {
    lines.push('No issuer integrity fields detected.');
    lines.push('Nothing here blocks re-encoding with an amount. Confirm with a live scan.');
  } else {
    lines.push(`${suspects.length} field(s) worth a closer look:`);
    for (const s of suspects) {
      lines.push(`  [${s.severity}] ${s.path}  ${s.reason}`);
      lines.push(`         ${s.value}`);
    }
    lines.push('');
    lines.push('If any of these is a signature over the payload, editing tag 54');
    lines.push('will be rejected by the acquirer regardless of a correct CRC.');
  }

  return lines.join('\n');
}
