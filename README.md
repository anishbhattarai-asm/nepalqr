# nepalqr

Take a merchant's existing **static** QR — the free one their bank already gave
them — and turn it into a **dynamic** QR carrying a transaction amount. No PSP,
no aggregator, no integration fees.

Zero dependencies.

```js
import { withAmount } from 'nepalqr';

const dynamicQR = withAmount(merchantStaticQR, 450.37);
// render dynamicQR as a QR image; customer scans, amount is pre-filled
```

## Why this might work

A Nepali merchant QR is a plain EMVCo Merchant-Presented Mode payload: 2-digit
tag, 2-digit length, value. The transaction amount is **tag 54**, an ordinary
field with no protection of its own. Merchant identity lives in tags 26–51 and
is copied through untouched.

So: decode the static QR once, set tag 54 per order, flip tag 01 to `12`
(dynamic), recompute the CRC. The merchant's bank relationship is unchanged.

## Why it might not

The tag-63 CRC is only an error-detecting checksum — anyone can recompute it.
But if the acquirer **also** embeds a MAC or hash over the payload, editing the
amount will be rejected on their side no matter how correct your CRC is.

`inspect` looks for exactly that:

```
$ npx nepalqr inspect "<real merchant qr payload>"
```

A clean report is encouraging. A `[high]` flag on a private template (tags
80–99) or a non-standard subtag inside tag 62 means you are probably looking at
issuer integrity data, and amount injection is likely dead.

**Neither result is proof.** Only a live scan settles it.

## The test that actually decides this

You need one real merchant QR. Then:

1. `nepalqr inspect "<payload>"` — anything flagged?
2. `nepalqr amount "<payload>" 1.50` — inject a trivial amount.
3. Render it (any QR library) and scan with eSewa / Khalti / a bank app.
4. Does the amount pre-fill? Does a 1.50 payment actually land?

Step 4 is the whole project. Everything else is downstream of it.

## Developing without a real QR

```
$ npx nepalqr fixture              # clean static merchant QR
$ npx nepalqr fixture --signed     # one carrying a fake issuer signature
```

Structurally real, invented merchant identifiers, will not move money. Good
enough to build the POS against; useless for answering the question above.

**Every identifier in this repository is invented.** The fixtures, the sample
SMS and the test data contain no real merchant id, account, phone number or
transaction reference. Point it at your own QR to do anything useful.

## API

| Function | Purpose |
| --- | --- |
| `withAmount(payload, amount, opts?)` | Inject amount, re-seal CRC. The main one. |
| `withoutAmount(payload)` | Strip amount, return to static form. |
| `decode(payload)` | Semantic object — merchant, amount, currency, CRC validity. |
| `inspect(payload)` | Human-readable TLV dump + signature warnings. |
| `detectOpaqueFields(payload)` | Just the warnings, as data. |
| `validate(payload)` | CRC check only. |
| `parseTLV` / `serializeTLV` / `seal` | Raw TLV access. |
| `parseAlert(text)` | Read a merchant credit alert into `{amount, payer, reference, channel}`. |
| `isCredit(text)` | Whether an alert is a credit this can act on. |

`withAmount` options:

- `billNumber` → tag 62.01
- `referenceLabel` → tag 62.05
- `terminalLabel` → tag 62.07
- `requireValidCRC` (default `true`) — refuse to modify a payload whose own CRC
  is already wrong, since that usually means a misread scan.

## Notes

- Field order from the source payload is preserved. Re-serializing an
  unmodified payload reproduces it exactly — verified in tests.
- CRC is computed over UTF-8 bytes, so non-ASCII merchant names checksum the
  way a scanner sees them.
- Length is counted in characters. For payloads with multi-byte merchant names
  this can disagree with byte-counting implementations; hasn't mattered in
  practice for ASCII-only fields, but worth knowing.

## Where this sits with the regulator

Worth knowing before relying on this.

Nepal Rastra Bank's *NepalQR Standardization Framework and Guidelines* and NCHL's
*NEPALPAY QR Operating Rules* are both public. Two parts matter here.

The Operating Rules define an acquirer as the party that "facilitate[s] generation
of merchant presented NEPALPAY QR code", and section 5.6 lists issuance of QR
codes, static **or dynamic**, as an acquirer function. So the sanctioned way to get
a dynamic QR is to ask the acquirer for one.

The Specifications describe tag 63 as a check "to detect any error on account of
data corruption or tampering". It is only a CRC and offers no real protection, but
that is its stated purpose, and recomputing it is what this library does.

Neither document binds merchants directly; they bind banks, PSPs and networks. A
merchant's obligations come from the merchant agreement signed with the acquirer,
which is a private contract. Read it before using this in a business.

## Reconciliation

Knowing a payment arrived, and which tab it belongs to. A merchant alert carries an
amount and a time but no order id, so `PaymentRegistry` makes the amount itself the
identifier by adding 0-99 paisa to each open request.

`parseAlert` reads the alert. A real eSewa SMS looks like:

```
Rs. 540.00 received From 9800000000 for RRN SAMPLE12345, Re:Others: dd/FonepayQR
```

The RRN is a unique transaction reference, which is what makes a duplicate forward
detectable rather than a second payment.

Still outside this module: getting alerts from the phone to the server, and doing so
over an authenticated channel. Anyone who can post to that endpoint can close a tab.

## Test

```
npm test
```

## License

MIT
