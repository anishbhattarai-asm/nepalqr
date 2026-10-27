/**
 * EMVCo TLV: every field is a 2-digit tag, a 2-digit decimal length, then
 * exactly that many characters of value. No terminators, no escaping.
 */

/** Tags whose values are themselves TLV. */
const NESTED = new Set();
for (let t = 26; t <= 51; t++) NESTED.add(pad2(t)); // additional payment networks
NESTED.add('62'); // additional data field template
NESTED.add('64'); // merchant information — language template
for (let t = 80; t <= 99; t++) NESTED.add(pad2(t)); // unreserved / private

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function isNested(tag) {
  return NESTED.has(tag);
}

/**
 * Flat parse, preserving source order.
 *
 * Order is preserved deliberately: re-serializing must reproduce the original
 * byte-for-byte, or the CRC you compute won't match the CRC the issuer signed.
 * Real-world QRs are not always in ascending tag order.
 */
export function parseTLV(payload) {
  const fields = [];
  let i = 0;

  while (i < payload.length) {
    if (i + 4 > payload.length) {
      throw new Error(`truncated TLV header at offset ${i}`);
    }

    const tag = payload.slice(i, i + 2);
    const lengthText = payload.slice(i + 2, i + 4);

    if (!/^\d{2}$/.test(lengthText)) {
      throw new Error(`bad length "${lengthText}" for tag ${tag} at offset ${i}`);
    }

    const length = Number(lengthText);
    const value = payload.slice(i + 4, i + 4 + length);

    if (value.length !== length) {
      throw new Error(
        `tag ${tag} claims ${length} chars but only ${value.length} remain`
      );
    }

    fields.push({ tag, value });
    i += 4 + length;
  }

  return fields;
}

export function serializeTLV(fields) {
  return fields
    .map(({ tag, value }) => {
      if (value.length > 99) {
        throw new Error(`tag ${tag} value is ${value.length} chars; max is 99`);
      }
      return tag + pad2(value.length) + value;
    })
    .join('');
}

/**
 * Recursive parse for display. Nested parsing is best-effort — a private tag
 * holding opaque bytes will fail to parse as TLV, and that is not an error,
 * it is a signal (see detectOpaqueFields in qr.js).
 */
export function parseTree(payload) {
  return parseTLV(payload).map((field) => {
    if (!isNested(field.tag)) return field;
    try {
      return { ...field, children: parseTree(field.value) };
    } catch {
      return field;
    }
  });
}

export function findField(fields, tag) {
  return fields.find((f) => f.tag === tag);
}

export function getValue(fields, tag) {
  return findField(fields, tag)?.value;
}

/**
 * Replace a field in place, or insert it in ascending tag position.
 *
 * In-place replacement matters: moving an existing field changes the payload
 * even when the content is identical, and some validators care.
 */
export function setField(fields, tag, value) {
  const existing = fields.findIndex((f) => f.tag === tag);
  if (existing !== -1) {
    fields[existing] = { tag, value };
    return fields;
  }

  const target = Number(tag);
  const insertAt = fields.findIndex((f) => Number(f.tag) > target);
  const field = { tag, value };

  if (insertAt === -1) fields.push(field);
  else fields.splice(insertAt, 0, field);

  return fields;
}

export function removeField(fields, tag) {
  const index = fields.findIndex((f) => f.tag === tag);
  if (index !== -1) fields.splice(index, 1);
  return fields;
}
