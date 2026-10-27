/** Human labels for the root tags defined by EMVCo MPM. */
export const ROOT_TAGS = {
  '00': 'Payload Format Indicator',
  '01': 'Point of Initiation Method',
  '52': 'Merchant Category Code',
  '53': 'Transaction Currency',
  '54': 'Transaction Amount',
  '55': 'Tip or Convenience Indicator',
  '56': 'Value of Convenience Fee Fixed',
  '57': 'Value of Convenience Fee Percentage',
  '58': 'Country Code',
  '59': 'Merchant Name',
  '60': 'Merchant City',
  '61': 'Postal Code',
  '62': 'Additional Data Field Template',
  '63': 'CRC',
  '64': 'Merchant Information — Language Template',
};

/** Subtags inside tag 62. Anything outside this set is unusual — see qr.js. */
export const ADDITIONAL_DATA_TAGS = {
  '01': 'Bill Number',
  '02': 'Mobile Number',
  '03': 'Store Label',
  '04': 'Loyalty Number',
  '05': 'Reference Label',
  '06': 'Customer Label',
  '07': 'Terminal Label',
  '08': 'Purpose of Transaction',
  '09': 'Additional Consumer Data Request',
};

/** Subtags inside a Merchant Account Information template (26-51). */
export const MERCHANT_ACCOUNT_TAGS = {
  '00': 'Globally Unique Identifier',
};

export function describeMerchantAccountTag(tag) {
  return MERCHANT_ACCOUNT_TAGS[tag] ?? 'Payment network specific';
}

export function describeTag(tag) {
  if (ROOT_TAGS[tag]) return ROOT_TAGS[tag];

  const n = Number(tag);
  if (n >= 2 && n <= 25) return 'Merchant Account Information (card network)';
  if (n >= 26 && n <= 51) return 'Merchant Account Information (payment network)';
  if (n >= 65 && n <= 79) return 'RFU for EMVCo';
  if (n >= 80 && n <= 99) return 'Unreserved / private template';
  return 'Unknown';
}

export const CURRENCIES = {
  524: 'NPR',
  356: 'INR',
  840: 'USD',
};

export const POINT_OF_INITIATION = {
  11: 'static (reusable, no amount)',
  12: 'dynamic (single use, amount included)',
};
