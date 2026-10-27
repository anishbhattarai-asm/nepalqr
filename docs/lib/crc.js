/**
 * CRC-16/CCITT-FALSE — the checksum EMVCo mandates for tag 63.
 *
 * poly 0x1021, init 0xFFFF, no input/output reflection, no final XOR.
 * Canonical check value: crc16("123456789") === 0x29B1
 *
 * Computed over UTF-8 bytes, not UTF-16 code units, so merchant names in
 * Devanagari checksum the same way a phone's scanner sees them.
 */

const encoder = new TextEncoder();

export function crc16(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let crc = 0xffff;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc;
}

/**
 * The 4 uppercase hex digits that belong in tag 63.
 *
 * `payload` must already end with the literal "6304" — the CRC field's own
 * tag and length are included in the checksum. Forgetting that is the single
 * most common way to produce a QR that scanners silently reject.
 */
export function checksum(payload) {
  return crc16(payload).toString(16).toUpperCase().padStart(4, '0');
}
