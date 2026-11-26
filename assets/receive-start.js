// Receive files page (receive/): receive by QR, anonymously.
//
// 1. Make a random one-time code (the relay room name) and key (the room's PIN), and show
//    <site>/send/#c=<code>&k=<key> as a QR. The key stays after '#', so no server ever sees it.
// 2. The sender scans it in Enidor and sends: their app registers a room under that code, locked
//    with the key (enidor_app/receive_qr.go).
// 3. We poll the relay's room directory for the code; when it appears, open the download page
//    with the code and key (d/#room=<code>&pin=<key>), which connects straight to the sender.
// Keep the QR format in sync with the app (enidor_app/frontend/src/lib/qr.js).
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const LINK_ID_RE = /^[0-9a-zA-Z]{12,64}$/;
  const POLL_MS = 2000;
  const LIFETIME_MS = 30 * 60 * 1000;

  const config = (() => {
    try {
      const raw = JSON.parse($('enidor-config').textContent);
      return { signal: String(raw.signal || '').replace(/\/+$/, '') };
    } catch {
      return { signal: '' };
    }
  })();

  // The site root, from this page's own address, so the QR works on any host.
  const siteRoot = new URL('../', location.href);

  function randomString(len, alphabet) {
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
    return out;
  }

  let session = null;
  let timer = 0;

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = !msg;
  }

  function newSession() {
    clearTimeout(timer);
    session = {
      code: randomString(16, 'abcdefghijklmnopqrstuvwxyz0123456789'),
      key: randomString(24, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'),
      expires: Date.now() + LIFETIME_MS,
    };
    const url = new URL(`send/#c=${session.code}&k=${session.key}`, siteRoot).href;
    $('rs-state').textContent = 'Waiting for the sender…';
    showError($('rs-error'), '');
    if (window.EnidorQR) {
      window.EnidorQR.toCanvas($('rs-qr'), url, { width: 260, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
        .catch(() => showError($('rs-error'), 'Couldn’t draw the QR code. Reload the page.'));
    }
    if (!config.signal) {
      showError($('rs-error'), 'Receiving isn’t available on this site right now.');
      return;
    }
    timer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    const s = session;
    if (!s) return;
    if (Date.now() > s.expires) {
      $('rs-state').textContent = 'This code has expired.';
      showError($('rs-error'), 'Tap “New code” and ask them to scan again.');
      return;
    }
    try {
      const res = await fetch(`${config.signal}/${s.code}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (res.ok && s === session) {
        $('rs-state').textContent = 'The sender is ready. Opening the download…';
        location.assign(new URL(`d/#room=${s.code}&pin=${s.key}`, siteRoot).href);
        return;
      }
    } catch {
      // Offline for a moment: keep waiting.
    }
    if (s === session) timer = setTimeout(poll, POLL_MS);
  }

  $('rs-new').addEventListener('click', newSession);

  // Pause while the tab is hidden; resume (with a fresh check) when it's back.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.visibilityState === 'visible' && session) poll();
  });

  // ---------- share link entry (the older way: a link made in Shares) ----------
  function parseLink(text) {
    const raw = (text || '').trim();
    if (!raw) return null;
    const bare = raw.replace(/[\s.-]/g, '');
    if (LINK_ID_RE.test(bare)) return bare;
    try {
      const u = new URL(raw);
      const id = (u.searchParams.get('link') || u.hash.slice(1) || '').trim();
      return LINK_ID_RE.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  $('rs-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = parseLink($('rs-input').value);
    if (id) location.assign(new URL(`d/?link=${encodeURIComponent(id)}`, siteRoot).href);
    else showError($('rs-input-error'), 'That doesn’t look like an Enidor share link or code.');
  });

  // receive/?link=<id> goes straight to that share's download.
  const direct = parseLink(new URLSearchParams(location.search).get('link') || '');
  if (direct) {
    location.replace(new URL(`d/?link=${encodeURIComponent(direct)}`, siteRoot).href);
    return;
  }

  newSession();
})();
