#!/usr/bin/env node
import { decode, inspect, validate, withAmount } from '../src/qr.js';
import { makeSignedStaticQR, makeStaticQR } from '../src/fixture.js';

const [command, ...args] = process.argv.slice(2);

const usage = `nepalqr — EMVCo merchant QR codec

  nepalqr inspect <payload>          dump the TLV tree, flag issuer signatures
  nepalqr decode <payload>           semantic view as JSON
  nepalqr amount <payload> <amount>  inject an amount, re-seal the CRC
  nepalqr validate <payload>         check the CRC only
  nepalqr fixture [--signed]         emit a fake static merchant QR

The inspect command is the one that matters first: run it on a real merchant
QR and see whether anything is flagged as issuer integrity data.
`;

function requirePayload(value, label = 'payload') {
  if (!value) {
    console.error(`missing <${label}>\n\n${usage}`);
    process.exit(1);
  }
  return value;
}

try {
  switch (command) {
    case 'inspect':
      console.log(inspect(requirePayload(args[0])));
      break;

    case 'decode':
      console.log(JSON.stringify(decode(requirePayload(args[0])), null, 2));
      break;

    case 'amount': {
      const payload = requirePayload(args[0]);
      const amount = requirePayload(args[1], 'amount');
      console.log(withAmount(payload, amount));
      break;
    }

    case 'validate': {
      const ok = validate(requirePayload(args[0]));
      console.log(ok ? 'valid' : 'INVALID');
      process.exit(ok ? 0 : 1);
      break;
    }

    case 'fixture':
      console.log(args.includes('--signed') ? makeSignedStaticQR() : makeStaticQR());
      break;

    default:
      console.log(usage);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
