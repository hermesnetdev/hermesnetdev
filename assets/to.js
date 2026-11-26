// Handle page (to/?h=@handle): opened when someone scans an Enidor QR with a normal camera app.
// The handle is shown as text only (textContent), and only if it looks like a real handle.
'use strict';

(function () {
  let h = (new URLSearchParams(location.search).get('h') || '').trim().toLowerCase();
  if (h && !h.startsWith('@')) h = `@${h}`;
  if (!/^@[a-z0-9_]{3,24}$/.test(h)) return;
  document.getElementById('to-handle').textContent = h;
  document.getElementById('to-title').textContent = `Send files to ${h}`;
  document.title = `Send files to ${h} · Enidor`;
})();
