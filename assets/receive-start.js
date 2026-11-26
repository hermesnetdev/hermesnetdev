// Receive files page (receive/): scan the sender's QR code or enter their link/code, then go to the
// browser download page (d/?link=<id>). QR formats match the app (enidor_app/frontend/src/lib/qr.js):
//   share link   <site>/d/?link=<id>   -> download page
//   handle QR    <site>/to/?h=@handle  -> that's for sending *to* someone; explained, not opened
'use strict';

(function () {
  const LINK_ID_RE = /^[0-9a-zA-Z]{12,64}$/;
  const $ = (id) => document.getElementById(id);

  // The download page for a link ID, relative to this page so it works on any host.
  const downloadUrl = (id) => new URL(`../d/?link=${encodeURIComponent(id)}`, location.href).href;

  // What the user scanned or typed: {linkId} | {handle} | null.
  function parse(text) {
    const raw = (text || '').trim();
    if (!raw) return null;
    const bare = raw.replace(/[\s.-]/g, '');
    if (LINK_ID_RE.test(bare)) return { linkId: bare };
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    const id = (u.searchParams.get('link') || '').trim();
    if (/\/d\/?$/.test(u.pathname) && LINK_ID_RE.test(id)) return { linkId: id };
    if (/\/d\/?$/.test(u.pathname) && LINK_ID_RE.test(u.hash.slice(1))) return { linkId: u.hash.slice(1) };
    if (/\/to\/?$/.test(u.pathname) && u.searchParams.get('h')) return { handle: u.searchParams.get('h') };
    return null;
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ---------- manual entry ----------
  $('rs-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const r = parse($('rs-input').value);
    if (r?.linkId) {
      location.assign(downloadUrl(r.linkId));
    } else if (r?.handle) {
      showError($('rs-input-error'), 'That’s someone’s Enidor handle, which is for sending to them. To receive, ask them for a link or QR code.');
    } else {
      showError($('rs-input-error'), 'That doesn’t look like an Enidor link or code. Check it and try again.');
    }
  });

  // ---------- camera scan ----------
  let stream = null;
  let raf = 0;

  function stopCamera() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $('rs-camera').hidden = true;
    $('rs-stop').hidden = true;
    $('rs-scan').hidden = false;
  }

  function tick() {
    const video = $('rs-video');
    const canvas = $('rs-canvas');
    if (video.readyState >= 2 && video.videoWidth && typeof jsQR === 'function') {
      const scale = Math.min(1, 640 / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const r = parse(code.data);
        if (r?.linkId) {
          stopCamera();
          location.assign(downloadUrl(r.linkId));
          return;
        }
        showError($('rs-scan-error'), r?.handle
          ? 'That’s someone’s Enidor handle QR, which is for sending to them. Ask the sender for their download QR code.'
          : 'That QR code isn’t an Enidor link. Point the camera at the code on the sender’s screen.');
      }
    }
    raf = requestAnimationFrame(tick);
  }

  $('rs-scan').addEventListener('click', async () => {
    showError($('rs-scan-error'), '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError($('rs-scan-error'), 'This browser can’t use the camera. Point your phone’s camera app at the code, or enter the link below.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const video = $('rs-video');
      video.srcObject = stream;
      $('rs-camera').hidden = false;
      $('rs-stop').hidden = false;
      $('rs-scan').hidden = true;
      await video.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    } catch (err) {
      stopCamera();
      const denied = /denied|notallowed|permission/i.test(`${err && err.name} ${err && err.message}`);
      showError($('rs-scan-error'), denied
        ? 'Camera access was blocked. Allow the camera for this site, or enter the link below.'
        : 'No camera is available. Enter the link or code below instead.');
    }
  });

  $('rs-stop').addEventListener('click', stopCamera);
  window.addEventListener('pagehide', stopCamera);

  // receive/?link=<id> (e.g. a link someone typed by hand) goes straight to the download.
  const direct = (new URLSearchParams(location.search).get('link') || '').replace(/[\s.-]/g, '');
  if (LINK_ID_RE.test(direct)) location.replace(downloadUrl(direct));
})();
