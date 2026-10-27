/**
 * Fake merchant QRs for development.
 *
 * These are structurally real EMVCo payloads with invented merchant
 * identifiers. They will parse, validate, and round-trip correctly — and they
 * will not move money. Replace with a genuine merchant QR before drawing any
 * conclusion about whether an acquirer accepts a modified payload.
 */

import { seal } from './qr.js';
import { serializeTLV } from './tlv.js';

/**
 * @param {object} [overrides]
 * @param {string} [overrides.acquirerGuid]  reverse-DNS or scheme id in 26.00
 * @param {string} [overrides.merchantId]    the merchant's account id, 26.01
 * @param {string} [overrides.name]
 * @param {string} [overrides.city]
 * @param {string} [overrides.mcc]           5813 = drinking places
 * @param {string} [overrides.currency]      524 = NPR
 * @param {string} [overrides.country]
 * @param {string} [overrides.terminalLabel]
 */
export function makeStaticQR(overrides = {}) {
  const {
    acquirerGuid = 'com.example.acquirer',
    merchantId = '9876543210001',
    name = 'DEMO BAR',
    city = 'KATHMANDU',
    mcc = '5813',
    currency = '524',
    country = 'NP',
    terminalLabel = 'POS01',
  } = overrides;

  const merchantAccount = serializeTLV([
    { tag: '00', value: acquirerGuid },
    { tag: '01', value: merchantId },
  ]);

  const additionalData = serializeTLV([{ tag: '07', value: terminalLabel }]);

  return seal([
    { tag: '00', value: '01' },
    { tag: '01', value: '11' }, // static
    { tag: '26', value: merchantAccount },
    { tag: '52', value: mcc },
    { tag: '53', value: currency },
    { tag: '58', value: country },
    { tag: '59', value: name },
    { tag: '60', value: city },
    { tag: '62', value: additionalData },
  ]);
}

/**
 * A fixture shaped like a real Fonepay merchant QR.
 *
 * Fonepay puts its GUID in 26.00 and the merchant identifier in subtag 26.07,
 * not 26.01. Verified against a live payload. The merchant id below is
 * invented — this will not move money.
 */
export function makeFonepayQR(overrides = {}) {
  const {
    merchantId = '2222050000000000',
    name = 'DEMO BAR',
    city = 'KATHMANDU',
    mcc = '5813',
    terminalLabel = '4260',
  } = overrides;

  return seal([
    { tag: '00', value: '01' },
    { tag: '01', value: '11' },
    {
      tag: '26',
      value: serializeTLV([
        { tag: '00', value: 'fonepay.com' },
        { tag: '07', value: merchantId },
      ]),
    },
    { tag: '52', value: mcc },
    { tag: '53', value: '524' },
    { tag: '58', value: 'NP' },
    { tag: '59', value: name },
    { tag: '60', value: city },
    { tag: '62', value: serializeTLV([{ tag: '07', value: terminalLabel }]) },
  ]);
}

/**
 * A static QR that also carries a plausible issuer signature, so you can see
 * what detectOpaqueFields() flags before you ever hold a real one.
 *
 * The signature here is arbitrary bytes — the point is the shape, not the
 * cryptography. If a real merchant QR looks like this, your amount injection
 * is probably dead in the water.
 */
export function makeSignedStaticQR(overrides = {}) {
  const {
    signature = 'A3F19C4E7B0D62815FA47C93E0B18D26',
    signatureTag = '80',
    ...rest
  } = overrides;

  const merchantAccount = serializeTLV([
    { tag: '00', value: rest.acquirerGuid ?? 'com.example.acquirer' },
    { tag: '01', value: rest.merchantId ?? '9876543210001' },
  ]);

  return seal([
    { tag: '00', value: '01' },
    { tag: '01', value: '11' },
    { tag: '26', value: merchantAccount },
    { tag: '52', value: rest.mcc ?? '5813' },
    { tag: '53', value: rest.currency ?? '524' },
    { tag: '58', value: rest.country ?? 'NP' },
    { tag: '59', value: rest.name ?? 'DEMO BAR' },
    { tag: '60', value: rest.city ?? 'KATHMANDU' },
    { tag: '62', value: serializeTLV([{ tag: '07', value: rest.terminalLabel ?? 'POS01' }]) },
    { tag: signatureTag, value: signature },
  ]);
}
