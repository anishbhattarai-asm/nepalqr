# Wiring into an Electron POS

## Where things live

The registry and every bank credential belong in the **main process**. The
renderer gets a QR string and settlement events — nothing else.

This isn't ceremony. The renderer is the process a bartender is looking at all
night. Anything reachable from it is reachable by whoever is standing at the
till.

```
main process          renderer
─────────────         ─────────────
PaymentRegistry  ←──  "open a payment for tab-7, Rs. 450"
bank alert feed  ──→  "tab-7 settled"
merchant QR
credentials
```

## Main process

```js
// main/payments.js
import { PaymentRegistry } from 'nepalqr/payments';
import { ipcMain } from 'electron';

const registry = new PaymentRegistry({
  merchantQR: loadMerchantQR(),   // from config, not from the renderer
  ttlMs: 180_000,
  strategy: 'paisa',              // 'none' if wallets mishandle paisa
}).startSweeping();

export function registerPaymentIPC(getWindow) {
  const push = (channel, payload) =>
    getWindow()?.webContents.send(channel, payload);

  registry.on('settled', ({ payment }) =>
    push('payment:settled', { id: payment.id, tabId: payment.tabId })
  );
  registry.on('expired', (payment) =>
    push('payment:expired', { id: payment.id, tabId: payment.tabId })
  );
  registry.on('unmatched', ({ credit }) =>
    push('payment:unmatched', { amount: credit.amount, at: credit.at })
  );
  registry.on('ambiguous', ({ credit, candidates }) =>
    push('payment:ambiguous', {
      amount: credit.amount,
      tabIds: candidates.map((c) => c.tabId),
    })
  );

  ipcMain.handle('payment:open', (_event, { tabId, amount, reference }) => {
    const p = registry.open({ tabId, amount, reference });
    // Deliberately partial: the renderer never needs the merchant payload.
    return {
      id: p.id,
      qr: p.qr,
      requestedAmount: p.requestedAmount,
      expiresAt: p.expiresAt,
    };
  });

  ipcMain.handle('payment:cancel', (_e, { id }) => !!registry.cancel(id));
  ipcMain.handle('payment:confirm', (_e, { id, by }) => {
    registry.confirmManually(id, { by });
    return true;
  });
}

export { registry };
```

## Preload

```js
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('payments', {
  open: (input) => ipcRenderer.invoke('payment:open', input),
  cancel: (id) => ipcRenderer.invoke('payment:cancel', { id }),
  confirm: (id, by) => ipcRenderer.invoke('payment:confirm', { id, by }),
  on: (event, handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(`payment:${event}`, listener);
    return () => ipcRenderer.off(`payment:${event}`, listener);
  },
});
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

## Renderer

```js
const { id, qr, requestedAmount } = await window.payments.open({
  tabId: tab.id,
  amount: tab.balance,
  reference: `TAB-${tab.number}`,
});

renderQRCode(qr);            // any QR image library
showAmount(requestedAmount); // show the exact figure the customer will see

const off = window.payments.on('settled', (p) => {
  if (p.id === id) { closeTab(tab.id); off(); }
});
```

Show `requestedAmount`, not the tab balance. With the paisa strategy they differ
by up to Rs. 0.99, and a bartender comparing the screen to the customer's phone
needs them to agree.

## Feeding in bank credits

Whatever your alert source is, it ends in one call:

```js
registry.ingest({
  amount: '450.64',
  at: Date.now(),
  raw: originalAlertText,   // keep it; you will want it at cash-up
  source: 'sms',
});
```

That's the entire adapter contract. Parsing an SMS, polling IMAP, or reading a
statement API all reduce to producing `{ amount, at, raw }`.

The parser is the bank-specific part and is the one piece not written yet.

## Surplus

Under the paisa strategy the customer pays up to Rs. 0.99 over the tab total.
`payment.surplusPaisa` records it per payment. Sum it into a daily rounding line
rather than letting it silently inflate revenue — it's small, but it will not
reconcile against the tabs otherwise.

## What must not happen

- The renderer never sees the merchant QR payload, bank credentials, or the
  alert feed.
- `ambiguous` never auto-settles. It is a prompt for the bartender, always.
- Manual confirmations stay flagged (`payment.manual`) so cash-up can separate
  bank-verified money from trusted-the-screen money.
