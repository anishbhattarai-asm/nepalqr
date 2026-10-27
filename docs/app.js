import {
  withAmount,
  decode,
  validate,
  detectOpaqueFields,
} from './lib/index.js';
import { makeStaticQR } from './lib/fixture.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'nepalqr.payload';

// Loaded as classic scripts in index.html.
const qrcode = window.qrcode;
const jsQR = window.jsQR;

let payload = null;

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tabpanel').forEach((p) => {
      p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
    if (tab.dataset.tab !== 'scan') stopScan();
  });
});

function loadPayload(text, { silent } = {}) {
  text = (text || '').trim();
  if (!text) return fail('Nothing to read.');

  let info;
  try {
    info = decode(text);
  } catch (e) {
    return fail('That does not look like a merchant QR payload.');
  }
  if (!validate(text)) {
    return fail('The QR failed its own checksum, likely a misread. Try again.');
  }

  payload = text;
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {}

  showMerchant(info);
  showInspection(text);
  if (!silent) stopScan();
  return true;

  function fail(msg) {
    setHint($('scanHint'), msg, 'error');
    return false;
  }
}

function showMerchant(info) {
  const name = info.merchantName || info.merchantCity || 'Your merchant QR';
  $('merchantName').textContent = name;
  $('charge').hidden = false;
  $('charge').scrollIntoView({ behavior: 'smooth', block: 'start' });
  render();
}

function showInspection(text) {
  const suspects = detectOpaqueFields(text);
  const box = $('inspect');
  const body = $('inspectBody');
  if (suspects.length === 0) {
    box.hidden = true;
    body.innerHTML = '';
    return;
  }
  box.hidden = false;
  const items = suspects
    .map(
      (s) =>
        `<li class="flag"><span class="sev-${s.severity}">[${s.severity}]</span> ` +
        `<code>${escapeHtml(s.path)}</code>: ${escapeHtml(s.reason)}</li>`
    )
    .join('');
  body.innerHTML =
    `<p>This QR carries fields that may be issuer integrity data. If any is a ` +
    `signature over the payload, an edited amount will be <strong>rejected</strong> ` +
    `by the bank no matter how correct this app is:</p><ul>${items}</ul>` +
    `<p>Test with Rs 1 before trusting it.</p>`;
}

function render() {
  if (!payload) return;
  const raw = $('amount').value.trim();
  const amount = Number(raw);
  const result = $('result');
  const hint = $('chargeHint');

  if (!raw || !(amount > 0)) {
    result.hidden = true;
    setHint(hint, '');
    return;
  }

  const remark = $('remark').value.trim();
  let dynamic;
  try {
    dynamic = withAmount(payload, amount, remark ? { purposeOfTransaction: remark } : {});
  } catch (e) {
    result.hidden = true;
    return setHint(hint, e.message, 'error');
  }

  drawQR(dynamic);
  $('shownAmount').textContent = 'Rs ' + decode(dynamic).amountRaw;
  $('shownRemark').textContent = remark ? '“' + remark + '”' : '';
  result.hidden = false;
  $('copyPayload').onclick = () => copy(dynamic);

  setHint(
    hint,
    remark
      ? 'Note: a remark writes into tag 62, which on some banks silences the ' +
          'merchant payment-alert SMS. Test on your own QR first.'
      : ''
  );
}

function drawQR(data) {
  const qr = qrcode(0, 'M');
  qr.addData(data);
  qr.make();
  $('qrcanvas').innerHTML = qr.createImgTag(6, 0);
  const img = $('qrcanvas').querySelector('img');
  if (img) { img.alt = 'Dynamic payment QR'; img.removeAttribute('width'); img.removeAttribute('height'); }
}

$('amount').addEventListener('input', render);
$('remark').addEventListener('input', render);

$('forget').addEventListener('click', () => {
  payload = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  $('charge').hidden = true;
  $('inspect').hidden = true;
  $('amount').value = '';
  $('remark').value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('usePaste').addEventListener('click', () => {
  if (loadPayload($('pasteInput').value)) setHint($('scanHint'), '');
});
$('useDemo').addEventListener('click', () => {
  const demo = makeStaticQR();
  $('pasteInput').value = demo;
  loadPayload(demo);
});

let stream = null;
let rafId = null;
const video = $('video');
const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return setHint($('scanHint'), 'This browser has no camera access. Paste the payload instead.', 'error');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (e) {
    return setHint($('scanHint'), 'Camera permission denied. You can paste the payload instead.', 'error');
  }
  video.srcObject = stream;
  await video.play();
  $('scanWrap').hidden = false;
  $('startScan').hidden = true;
  $('stopScan').hidden = false;
  setHint($('scanHint'), 'Point the camera at your merchant QR…');
  tick();
}

function tick() {
  if (!stream) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    scanCanvas.width = video.videoWidth;
    scanCanvas.height = video.videoHeight;
    scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    const img = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      if (loadPayload(code.data, { silent: true })) {
        setHint($('scanHint'), 'Got it ✓', 'ok');
        stopScan();
        return;
      }
    }
  }
  rafId = requestAnimationFrame(tick);
}

function stopScan() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  $('scanWrap').hidden = true;
  $('startScan').hidden = false;
  $('stopScan').hidden = true;
}

$('startScan').addEventListener('click', startScan);
$('stopScan').addEventListener('click', stopScan);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

function setHint(el, msg, kind = '') {
  el.textContent = msg;
  el.className = 'hint' + (kind ? ' ' + kind : '');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setHint($('chargeHint'), 'Payload copied.', 'ok');
  } catch {
    setHint($('chargeHint'), 'Copy failed, select the payload manually.', 'error');
  }
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('sw.js').catch(() => {})
  );
}

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) loadPayload(saved, { silent: true });
} catch {}
