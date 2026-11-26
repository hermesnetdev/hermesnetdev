// The receive page (d/): downloads a Guest Room share straight from the sharer's computer.
//
// It speaks the same protocol as the desktop app (From_project_1/internal/core/node.go):
//   0. GET {signal-base}/link/resolve/{link} → { room_code, peer_id }: the sharer the link was made by
//   1. GET {signal}/{code}         → the sharer's relayed multiaddr; its peer ID must be that sharer
//   2. dial {relay}/p2p-circuit/webrtc/p2p/{peer}: the relay (reached over WSS or WebTransport)
//      carries only a WebRTC handshake, then both sides hole-punch to a direct connection. File
//      data only ever travels over that direct connection, never through the relay: if no direct
//      path can be found, the page says so instead of falling back.
//   3. /streamfs/meta/1.2.0        → "code\nsubPath\nguestName\n", answered with a JSON FileList
//   4. /streamfs/data/1.2.0        → "code\npath\nguestName\ndownload\n" + int64 offset + int64 length
//                                    (big-endian), answered with the raw bytes
// Bytes are written into the browser's private file system as they arrive. When the whole file
// is in, the visitor chooses whether to save it to their computer. Interrupted transfers resume
// from the last byte received, the way the app's own downloads do.

import {
  createLibp2p, webSockets, webTransport, webRTC, circuitRelayTransport, identify, noise, yamux, multiaddr,
} from './vendor/libp2p.js';

const PROTOCOL_META = '/streamfs/meta/1.2.0';
const PROTOCOL_DATA = '/streamfs/data/1.2.0';

const LOOKUP_TIMEOUT_MS = 10_000;
// Each attempt at a direct connection gets longer: the first usually connects in a few seconds,
// and a slow STUN server or a router busy opening a mapping can make the next one take longer.
const DIRECT_ATTEMPT_TIMEOUTS_MS = [20_000, 30_000, 45_000];
const STREAM_OPEN_TIMEOUT_MS = 20_000;
const LISTING_TIMEOUT_MS = 45_000;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
const MAX_STALLED_ATTEMPTS = 8; // same as the app: give up after 8 retries in a row that moved no bytes
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;
const WRITE_BATCH_BYTES = 4 * 1024 * 1024;
const STREAM_BUFFER_BYTES = 16 * 1024 * 1024; // how far video and audio previews read ahead
const MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024; // only used when the browser has no private file system
const MAX_INFLIGHT_WRITE_BYTES = 32 * 1024 * 1024; // bytes handed to the storage worker but not yet on disk
const RESOLVE_TIMEOUT_MS = 15_000;
const TEXT_PREVIEW_BYTES = 256 * 1024;
const SW_STREAM_PREFIX = '--enidor-stream--';
// Identifies this tab to the service worker, so a stream request is only ever answered by the
// page that made it, never by another open share.
const STREAM_SESSION = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const OPFS_DIR = 'enidor-downloads';
const OPFS_STALE_MS = 60 * 60 * 1000;
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// STUN only, and never TURN: a TURN server would relay the data, which is exactly what the page
// must not do. These match the app's (internal/core/webrtc DefaultICEServers).
const RTC_CONFIGURATION = {
  iceServers: [{
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:global.stun.twilio.com:3478',
      'stun:stun.cloudflare.com:3478',
      'stun:stun.services.mozilla.com:3478',
    ],
  }],
  iceTransportPolicy: 'all',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------- small helpers ----------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false || child === '') continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// Static, trusted markup only — file names and anything else from the sharer go through el().
const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  video: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="m4 17 5-4 4 3 3-2 4 3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.5L16 9.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  offline: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.4M19 13a10 10 0 0 0-2.3-1.6M2 9.5a15 15 0 0 1 4.5-2.8M22 9.5A15 15 0 0 0 11 5.6M12 20v.01"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
};

function icon(name, cls = '') {
  const span = el('span', { class: `glyph ${cls}`.trim(), 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return span;
}

// Files that run code when opened, or that browsers render as active content. They can still be
// downloaded, but only after a warning, and they are never previewed as anything but text.
const RISKY_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'cpl', 'msi', 'msix', 'msp', 'appx', 'appxbundle', 'bat', 'cmd', 'ps1', 'psm1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'reg', 'jar', 'sh', 'command', 'app', 'pkg',
  'dmg', 'deb', 'rpm', 'appimage', 'apk', 'bin', 'html', 'htm', 'xhtml', 'svg', 'mht', 'mhtml',
]);

function extensionOf(name) {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function isRisky(name) {
  return RISKY_EXTENSIONS.has(extensionOf(name));
}

function getMimeType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const types = {
    'mp4': 'video/mp4', 'mkv': 'video/x-matroska', 'webm': 'video/webm', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo',
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'flac': 'audio/flac', 'm4a': 'audio/mp4',
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'avif': 'image/avif', 'bmp': 'image/bmp',
    'pdf': 'application/pdf',
    // Never an active type (html, svg, xml, js…): shared content must not run in this origin.
    'txt': 'text/plain', 'csv': 'text/plain', 'md': 'text/plain', 'json': 'text/plain', 'html': 'text/plain', 'htm': 'text/plain',
    'svg': 'text/plain', 'xml': 'text/plain', 'xhtml': 'text/plain', 'css': 'text/plain', 'js': 'text/plain', 'mjs': 'text/plain',
    'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'zip': 'application/zip', 'rar': 'application/vnd.rar', '7z': 'application/x-7z-compressed', 'tar': 'application/x-tar', 'gz': 'application/gzip'
  };
  return types[ext] || 'application/octet-stream';
}

// What, if anything, the page may preview. Only passive formats: images, audio, video, PDF (in a
// sandboxed frame) and text (as text, never as markup).
function previewKind(name) {
  const ext = extensionOf(name);
  if (/^(jpe?g|png|gif|webp|avif|bmp)$/.test(ext)) return 'image';
  if (/^(mp3|wav|ogg|oga|m4a|aac|opus|flac)$/.test(ext)) return 'audio';
  if (/^(mp4|m4v|webm|mov|ogv)$/.test(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (/^(txt|text|log|md|markdown|csv|tsv|json|xml|ya?ml|toml|ini|conf|cfg|srt|vtt|html?|xhtml|svg|css|m?js|ts|py|go|rs|java|c|h|cpp|sh)$/.test(ext)) return 'text';
  return null;
}

function kindOf(item) {
  if (item.is_dir) return 'folder';
  const ext = (item.name.split('.').pop() || '').toLowerCase();
  if (/^(mp4|mkv|mov|avi|webm|m4v|wmv|flv|mts|m2ts)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|aac|m4a|ogg|opus|aiff|aif|alac|wma)$/.test(ext)) return 'audio';
  if (/^(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|svg|raw|cr2|cr3|nef|arw|dng|psd)$/.test(ext)) return 'image';
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|dmg|iso)$/.test(ext)) return 'archive';
  return 'file';
}

function formatBytes(bytes) {
  if (!(bytes >= 1024)) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function spacedCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Exponential backoff with jitter, so many visitors retrying at once don't move in lockstep.
function backoff(attempt) {
  const ms = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return ms / 2 + Math.random() * (ms / 2);
}

// A chunk from a libp2p stream is either a Uint8Array or a Uint8ArrayList of them.
function segments(chunk) {
  return ArrayBuffer.isView(chunk) ? [chunk] : chunk;
}

// ---------- setup: config, code, who we are ----------

function readConfig() {
  try {
    const raw = JSON.parse(document.getElementById('enidor-config').textContent);
    return {
      signal: String(raw.signal || '').replace(/\/+$/, ''),
      relays: (Array.isArray(raw.relays) ? raw.relays : []).map(String).filter(Boolean),
    };
  } catch {
    return { signal: '', relays: [] };
  }
}

const PEER_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{40,80}$/;

// Share links look like d/?link=<id>, optionally with #peer=<sharer's peer ID> (which then must
// match). d/#<id> works too. Old 6-digit room codes (d/#482913) are recognised only to explain
// that they no longer work.
function readLink() {
  const params = new URLSearchParams(location.search);
  const rawHash = location.hash.slice(1);
  const hashParams = rawHash.includes('=') ? new URLSearchParams(rawHash) : null;
  let hash = hashParams ? '' : rawHash;
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // leave it as typed
  }
  let id = null;
  let legacy = false;
  for (const raw of [hashParams?.get('link'), params.get('link'), hash, params.get('c'), params.get('code')]) {
    const clean = (raw || '').replace(/[\s.-]/g, '');
    if (/^[0-9a-zA-Z]{12,64}$/.test(clean)) {
      id = clean;
      break;
    }
    if (/^\d{6}$/.test(clean)) legacy = true;
  }
  const peer = (hashParams?.get('peer') || params.get('peer') || '').trim();
  // Receive by QR (receive/): #room=<one-time code>&pin=<its key>. No link record; whoever answered
  // the QR registered that code, and the key is the room's PIN.
  const room = (hashParams?.get('room') || '').trim();
  const pin = (hashParams?.get('pin') || '').trim();
  if (/^[a-z0-9]{16}$/.test(room) && /^[A-Za-z0-9]{20,64}$/.test(pin)) {
    return { id: null, legacy: false, peer: '', room, pin };
  }
  return { id, legacy: !id && legacy, peer: PEER_ID_RE.test(peer) ? peer : '' };
}

// Shown to the sharer in their Activity Monitor and audit log.
function guestName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
      : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows'
          : /Linux/.test(ua) ? 'Linux' : '';
  return `Web guest · ${browser}${os ? ` on ${os}` : ''}`;
}

// ---------- errors the page knows how to explain ----------

class ShareError extends Error {
  constructor(kind, message, cause) {
    super(message || kind, { cause });
    this.kind = kind; // not-found | lookup-failed | busy | offline | unreachable | no-direct | closed | too-big | stalled | storage | truncated | mismatch
  }
}

// ---------- the peer-to-peer session ----------

class Session {
  constructor(code, peerId, relays) {
    this.code = code;
    this.peerId = peerId;
    this.relays = relays;
    this.relayIds = new Set(relays.map((r) => r.split('/p2p/').pop()));
    this.preferred = 0;
    this.guest = guestName();
    this.node = null;
    this.conn = null;
    this.connecting = null;
    this.state = 'idle'; // idle | connecting | direct | reconnecting
    this.onState = null;
    this.pin = '';
  }

  async start() {
    const allowed = this.relays;
    this.node = await createLibp2p({
      transports: [webSockets(), webTransport(), webRTC({ rtcConfiguration: RTC_CONFIGURATION }), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      // The page only ever talks to the configured relays, and to the sharer through them.
      connectionGater: {
        denyDialMultiaddr: (ma) => !allowed.some((relay) => ma.toString().startsWith(relay)),
      },
    });
    // When the direct connection drops, say so, and reconnect before the next request needs it.
    this.node.addEventListener('connection:close', (evt) => {
      if (evt.detail !== this.conn) return;
      this.conn = null;
      this.setState('reconnecting');
      this.connect().catch(() => {}); // a running transfer reports its own failure
    });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state);
  }

  relayConnected() {
    return this.node.getConnections().some((c) => this.relayIds.has(c.remotePeer.toString()));
  }

  // A connection we may move file data over: WebRTC straight to the sharer, not a relay circuit.
  static isDirect(conn) {
    const addr = conn.remoteAddr.toString();
    return conn.status === 'open' && conn.limits == null && /\/webrtc(\/|$)/.test(addr);
  }

  // Connects straight to the sharer's computer over WebRTC. The relay only carries the handshake.
  // Concurrent callers share one attempt.
  connect(signal) {
    if (this.conn && Session.isDirect(this.conn)) return Promise.resolve(this.conn);
    if (!this.connecting) {
      this.setState(this.state === 'direct' || this.state === 'reconnecting' ? 'reconnecting' : 'connecting');
      this.connecting = this.dialDirect().finally(() => {
        this.connecting = null;
      });
    }
    if (!signal) return this.connecting;
    return Promise.race([
      this.connecting,
      new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  }

  async dialDirect() {
    const order = this.relays.map((_, i) => (i + this.preferred) % this.relays.length);
    let lastErr;
    for (let attempt = 0; attempt < DIRECT_ATTEMPT_TIMEOUTS_MS.length; attempt++) {
      for (const i of order) {
        const target = multiaddr(`${this.relays[i]}/p2p-circuit/webrtc/p2p/${this.peerId}`);
        try {
          const conn = await this.node.dial(target, {
            signal: AbortSignal.timeout(DIRECT_ATTEMPT_TIMEOUTS_MS[attempt]),
            force: true, // a relayed connection to the sharer may already exist; we want WebRTC
          });
          if (!Session.isDirect(conn)) {
            await conn.close().catch(() => {});
            throw new Error(`not a direct connection: ${conn.remoteAddr}`);
          }
          // Noise authenticates the remote key; make sure it is the sharer the link names.
          if (conn.remotePeer.toString() !== this.peerId) {
            await conn.close().catch(() => {});
            throw new ShareError('mismatch', `connected to ${conn.remotePeer} instead of ${this.peerId}`);
          }
          this.conn = conn;
          this.preferred = i;
          this.dropRelayedConnections();
          this.setState('direct');
          return conn;
        } catch (err) {
          if (err instanceof ShareError) throw err;
          lastErr = err;
          console.info(`Enidor: direct connection attempt ${attempt + 1} via relay ${i + 1} failed`, err);
        }
      }
      if (attempt < DIRECT_ATTEMPT_TIMEOUTS_MS.length - 1) await sleep(backoff(attempt + 1));
    }
    this.setState('idle');
    // The relay answered but the sharer didn't: offline. The sharer answered the handshake but no
    // direct path opened: the networks block it. Neither: we couldn't reach the network at all.
    const kind = !this.relayConnected() ? 'unreachable'
      : /NO_RESERVATION|no reservation|not connected/i.test(String(lastErr?.message)) ? 'offline' : 'no-direct';
    throw new ShareError(kind, lastErr?.message, lastErr);
  }

  // The relayed connection to the sharer carried the handshake; once the direct one is up it has
  // no further use, and closing it means nothing can ever be sent over it.
  dropRelayedConnections() {
    for (const c of this.node.getConnections(this.conn.remotePeer)) {
      if (c !== this.conn) c.close().catch(() => {});
    }
  }

  async open(protocol, signal) {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connect(signal);
      try {
        // Never runOnLimitedConnection: a limited connection is a relayed one.
        return await conn.newStream(protocol, { signal: withTimeout(signal, STREAM_OPEN_TIMEOUT_MS) });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (Session.isDirect(conn) || attempt > 0) throw err;
        if (this.conn === conn) this.conn = null; // it closed under us; connect again
      }
    }
  }

  async list(subPath) {
    const signal = AbortSignal.timeout(LISTING_TIMEOUT_MS);
    const stream = await this.open(PROTOCOL_META, signal);
    const reading = readAll(stream, signal); // listen before asking, so no reply can slip past
    stream.send(encoder.encode(`${this.code}\n${subPath}\n${this.guest}\n${this.pin}\n`));
    closeWrite(stream);
    return JSON.parse(decoder.decode(await reading));
  }

  // Streams [offset, offset + length) of a file into onBytes. Resolves when the sharer closes the
  // stream, which may be early if the connection drops; the caller resumes from what it got.
  // If onBytes returns a promise, reading pauses until it settles, which backs the sender off.
  async fetchRange(path, offset, length, onBytes, signal) {
    const stream = await this.open(PROTOCOL_DATA, signal);
    const head = encoder.encode(`${this.code}\n${path}\n${this.guest}\n${this.pin}\ndownload\n`);
    const request = new Uint8Array(head.length + 16);
    request.set(head);
    const view = new DataView(request.buffer);
    view.setBigInt64(head.length, BigInt(offset));
    view.setBigInt64(head.length + 8, BigInt(length));

    const abort = () => stream.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const reading = (async () => {
        for await (const chunk of stream) {
          for (const bytes of segments(chunk)) {
            const wait = onBytes(bytes);
            if (wait) await wait;
          }
        }
      })();
      stream.send(request);
      closeWrite(stream);
      await reading;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  // Like fetchRange, but keeps going until all `length` bytes are in, resuming from the last byte
  // received whenever the connection drops. Gives up after MAX_STALLED_ATTEMPTS tries in a row
  // that move nothing.
  async fetchAll(path, offset, length, onBytes, signal, onRetry) {
    let received = 0;
    let stalled = 0;
    let lastErr = null;
    const count = (bytes) => {
      received += bytes.byteLength;
      return onBytes(bytes);
    };
    while (received < length) {
      const before = received;
      try {
        await this.fetchRange(path, offset + received, length - received, count, signal);
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        // connect() has already retried; another round of reconnects won't do better.
        if (err instanceof ShareError) throw err;
        lastErr = err;
      }
      if (received >= length) break;
      stalled = received > before ? 0 : stalled + 1;
      if (stalled >= MAX_STALLED_ATTEMPTS) {
        throw new ShareError('stalled', lastErr?.message, lastErr);
      }
      onRetry?.();
      await sleep(backoff(stalled), signal);
    }
  }

  async stop() {
    await this.node?.stop().catch(() => {});
  }
}

// Tells the sharer we're done asking. Over WebRTC the close waits for an acknowledgement that the
// app sends only once the whole reply is out, so don't wait on it: a failed transfer shows up in
// the read loop, not here.
function closeWrite(stream) {
  stream.close().catch(() => {});
}

async function readAll(stream, signal) {
  const abort = () => stream.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const parts = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      for (const bytes of segments(chunk)) {
        parts.push(bytes.slice());
        size += bytes.byteLength;
      }
      if (size > MAX_LISTING_BYTES) throw new Error('folder listing too large');
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// Asks the directory which peer is hosting the code.
async function lookUp(signalUrl, code) {
  let res;
  try {
    res = await fetch(`${signalUrl}/${code}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), cache: 'no-store' });
  } catch (err) {
    throw new ShareError('lookup-failed', err.message, err);
  }
  if (res.status === 404) throw new ShareError('not-found');
  if (res.status === 429) throw new ShareError('busy');
  if (!res.ok) throw new ShareError('lookup-failed', `directory responded ${res.status}`);
  const addr = (await res.text()).trim();
  const peerId = addr.split('/p2p/').pop();
  if (!addr.includes('/p2p/') || !PEER_ID_RE.test(peerId)) {
    throw new ShareError('lookup-failed', 'invalid room record');
  }
  return peerId;
}

// Resolves a share link to its room code and the sharer's peer ID (recorded by the directory from
// the sharer's signed request).
async function resolveLink(signalUrl, id) {
  const url = `${signalUrl.replace(/\/room\/?$/, '/link/resolve')}/${encodeURIComponent(id)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS), cache: 'no-store' });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ShareError('lookup-failed', timedOut ? 'the directory did not answer in time' : err.message, err);
  }
  if (res.status === 404) throw new ShareError('not-found', 'Link not found or expired.');
  if (res.status === 429) throw new ShareError('busy');
  if (!res.ok) throw new ShareError('lookup-failed', `directory responded ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new ShareError('lookup-failed', 'invalid link record', err);
  }
  const roomCode = String(data?.room_code || '');
  const peerId = String(data?.peer_id || '');
  if (!/^[0-9A-Za-z_-]{4,64}$/.test(roomCode) || !PEER_ID_RE.test(peerId)) {
    throw new ShareError('lookup-failed', 'invalid link record');
  }
  return { roomCode, peerId };
}

// ---------- where downloads are kept until the visitor saves them ----------

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

// Leftovers from earlier visits. Files still being written in another tab are locked and skipped.
async function sweepOldDownloads() {
  try {
    const dir = await opfsDir();
    for await (const [name, handle] of dir.entries()) {
      try {
        const file = await handle.getFile();
        if (Date.now() - file.lastModified > OPFS_STALE_MS) await dir.removeEntry(name);
      } catch {
        // locked or already gone
      }
    }
  } catch {
    // no private file system here
  }
}

async function freeSpace() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (Number.isFinite(quota)) return Math.max(0, quota - (usage || 0)) * 0.95;
  } catch {
    // unknown
  }
  return Infinity;
}

class OpfsSink {
  static async open() {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const worker = new Worker(new URL('./receive-worker.js', import.meta.url));
    const sink = new OpfsSink(worker, name);
    try {
      await sink.call({ op: 'open', dir: OPFS_DIR, name });
    } catch (err) {
      await sink.discard();
      throw err;
    }
    return sink;
  }

  constructor(worker, name) {
    this.worker = worker;
    this.name = name;
    this.error = null;
    this.pending = new Map();
    this.nextId = 1;
    this.inflight = 0; // bytes posted to the worker and not yet acknowledged
    this.drained = null; // { promise, resolve } while a writer waits for the worker to catch up
    worker.onmessage = ({ data }) => {
      const err = data.error && Object.assign(new Error(data.error.message), { name: data.error.name });
      const call = this.pending.get(data.id);
      if (!call) {
        this.error ??= err; // a write failed, usually because storage filled up
        return;
      }
      this.pending.delete(data.id);
      if (err) call.reject(err);
      else call.resolve();
    };
    worker.onerror = (evt) => {
      this.error ??= new Error(evt.message || 'storage worker failed');
      for (const call of this.pending.values()) call.reject(this.error);
      this.pending.clear();
      this.inflight = 0;
      this.wake();
    };
  }

  wake() {
    if (this.drained && (this.error || this.inflight <= MAX_INFLIGHT_WRITE_BYTES / 2)) {
      this.drained.resolve();
      this.drained = null;
    }
  }

  call(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  // Takes ownership of buffer (it's transferred to the worker). Returns a promise when too much is
  // waiting to be written, so the caller stops reading from the network until the disk catches up.
  write(buffer, length, at) {
    const id = this.nextId++;
    this.inflight += length;
    const settle = () => {
      this.inflight -= length;
      this.wake();
    };
    this.pending.set(id, {
      resolve: settle,
      reject: (err) => {
        this.error ??= err; // usually storage filled up
        settle();
      },
    });
    this.worker.postMessage({ op: 'write', id, buffer: buffer.buffer, length, at }, [buffer.buffer]);
    if (this.inflight <= MAX_INFLIGHT_WRITE_BYTES) return null;
    if (!this.drained) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this.drained = { promise, resolve };
    }
    return this.drained.promise;
  }

  async finish() {
    await this.call({ op: 'close' });
    this.worker.terminate();
    if (this.error) throw this.error;
    const handle = await (await opfsDir()).getFileHandle(this.name);
    return handle.getFile();
  }

  async discard() {
    await this.call({ op: 'close' }).catch(() => {});
    this.worker.terminate();
    await removeStored(this.name);
  }
}

class MemorySink {
  constructor() {
    this.parts = [];
    this.error = null;
    this.name = null;
    this.inMemory = true;
  }

  write(buffer, length) {
    this.parts.push(buffer.subarray(0, length));
    return null;
  }

  async finish() {
    return new Blob(this.parts);
  }

  async discard() {
    this.parts = [];
  }
}

async function removeStored(name) {
  if (!name) return;
  try {
    await (await opfsDir()).removeEntry(name);
  } catch {
    // already gone
  }
}

async function openSink(total) {
  const room = await freeSpace();
  try {
    const sink = await OpfsSink.open();
    if (total > room) {
      await sink.discard();
      throw new ShareError('too-big', '', { needed: total, available: room });
    }
    return sink;
  } catch (err) {
    if (err instanceof ShareError) throw err;
    console.info('Enidor: no private file system here, keeping the download in memory.', err);
  }
  if (total > MEMORY_LIMIT_BYTES) {
    throw new ShareError('too-big', '', { needed: total, available: MEMORY_LIMIT_BYTES });
  }
  return new MemorySink();
}

// Collects incoming bytes into large buffers so the disk sees a few big writes, not thousands of small ones.
class Batcher {
  constructor(sink, total) {
    this.sink = sink;
    this.size = Math.max(1, Math.min(WRITE_BATCH_BYTES, total));
    this.buffer = new Uint8Array(this.size);
    this.length = 0;
    this.at = 0;
  }

  // Returns a promise if the sink wants the caller to slow down.
  push(bytes) {
    let offset = 0;
    let wait = null;
    while (offset < bytes.length) {
      const n = Math.min(bytes.length - offset, this.size - this.length);
      this.buffer.set(bytes.subarray(offset, offset + n), this.length);
      this.length += n;
      offset += n;
      if (this.length === this.size) wait = this.flush() || wait;
    }
    return wait;
  }

  flush() {
    if (!this.length) return null;
    const wait = this.sink.write(this.buffer, this.length, this.at);
    this.at += this.length;
    this.buffer = new Uint8Array(this.size);
    this.length = 0;
    return wait;
  }
}

// A zip ends with an end-of-central-directory record (PK\x05\x06) in its last 64 KiB + 22 bytes.
// Folder downloads are zipped on the fly with no length up front, so this is how we tell a
// complete archive from one cut off mid-stream.
async function zipLooksComplete(blob) {
  const EOCD = 22;
  if (blob.size < EOCD) return false;
  const tailStart = Math.max(0, blob.size - (EOCD + 0xffff));
  const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  const view = new DataView(tail.buffer);
  for (let i = tail.length - EOCD; i >= 0; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + EOCD + commentLength !== tail.length) continue; // the record must end the file
    const cdSize = view.getUint32(i + 12, true);
    const cdOffset = view.getUint32(i + 16, true);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // Zip64: the real values live in the zip64 record, located just before this one.
      return i >= 20 && view.getUint32(i - 20, true) === 0x07064b50;
    }
    return cdOffset + cdSize === tailStart + i;
  }
  return false;
}

// Rolling transfer speed over the last few seconds.
class Meter {
  constructor(start) {
    this.samples = [[performance.now(), start]];
  }

  add(bytes) {
    const now = performance.now();
    this.samples.push([now, bytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 5000) this.samples.shift();
  }

  speed() {
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    return t1 - t0 > 400 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }
}

// ---------- page state ----------

const config = readConfig();
const link = readLink();
let code = null;
let expectedPeer = link.peer; // the sharer's peer ID, from the link fragment or the link record
const ui = {
  kicker: document.getElementById('rx-kicker'),
  title: document.getElementById('rx-title'),
  lede: document.getElementById('rx-lede'),
  code: document.getElementById('rx-code'),
  card: document.getElementById('rx-card'),
};

let session = null;
let host = '';
let singleFile = false;
let path = '';
let listing = null;
let transfer = null; // { controller, sink } while a download runs
let stored = null; // { item, file, url, name } once a download is complete

function setCard(...children) {
  ui.card.replaceChildren(...children);
  ui.card.classList.remove('is-busy');
}

function button(label, cls, onclick, attrs) {
  return el('button', { type: 'button', class: `btn ${cls}`, onclick, ...attrs }, label);
}

// The hash holds the room code, so links to the promo scroll instead of navigating to an anchor.
function appLink(label = 'Get Enidor', cls = 'btn-primary') {
  return el('a', { class: `btn ${cls}`, href: '../#releases', 'data-scroll': 'get-enidor' }, label);
}

function showStatus(text, detail) {
  setCard(
    el('div', { class: 'rx-status', role: 'status' },
      el('span', { class: 'rx-spinner', 'aria-hidden': 'true' }),
      el('div', null,
        el('p', { class: 'rx-status-text' }, text),
        detail && el('p', { class: 'rx-note' }, detail),
      ),
    ),
  );
  ui.card.classList.add('is-busy');
}

function showMessage({ glyph = 'alert', tone = '', title, body, actions = [], extra }) {
  setCard(
    el('div', { class: 'rx-message' },
      icon(glyph, `rx-big ${tone}`),
      el('h2', { class: 'rx-card-title' }, title),
      body && el('p', { class: 'rx-card-body' }, body),
      extra,
      actions.length > 0 && el('div', { class: 'rx-actions' }, actions),
    ),
  );
}

function openInAppSteps() {
  return el('ol', { class: 'rx-steps' },
    el('li', null, 'Install Enidor — it’s free for macOS and Windows.'),
    el('li', null, 'Click ', el('strong', null, 'Join a Guest Room'), '.'),
    code
      ? el('li', null, 'Enter ', el('strong', { class: 'rx-mono' }, spacedCode(code)), '.')
      : el('li', null, 'Enter the 6-digit code the sender gave you.'),
  );
}


function showError(err) {
  console.warn('Enidor:', err);
  const retry = typeof err?.retry === 'function'
    ? button('Try again', 'btn-primary', err.retry)
    : button('Try again', 'btn-primary', () => location.reload());
  const kind = err instanceof ShareError ? err.kind : 'unknown';
  if (kind === 'not-found' || kind === 'closed' || kind === 'mismatch') {
    ui.title.textContent = 'This share isn’t available.';
    ui.lede.hidden = true;
  }
  switch (kind) {
    case 'not-found':
      return showMessage({
        title: 'No share uses this link',
        body: 'This link is invalid, expired, or the room was never opened. Ask the sender to check their link.',
      });
    case 'closed':
      return showMessage({
        title: 'This room is closed',
        body: 'The sender stopped sharing this folder, or it’s no longer on their computer. Ask them to share it again.',
      });
    case 'mismatch':
      return showMessage({
        title: 'This link doesn’t lead to its sender',
        body: 'The computer answering for this share isn’t the one the link was made for, so nothing was downloaded. Ask the sender for a new link.',
      });
    case 'busy':
      return showMessage({
        glyph: 'offline',
        title: 'Too many attempts',
        body: 'The Enidor directory is limiting requests from your network. Wait a minute and try again.',
        actions: [retry],
      });
    case 'offline':
      return showMessage({
        glyph: 'offline',
        title: 'The sender’s computer is offline',
        body: 'Files come straight from their computer, so it needs to be switched on with Enidor running. Try again once it is.',
        actions: [retry],
      });
    case 'unreachable':
    case 'lookup-failed':
      return showMessage({
        glyph: 'offline',
        title: 'Couldn’t reach the Enidor network',
        body: 'Check your internet connection and try again. Some work and school networks block peer-to-peer connections — if that’s the case here, the Enidor app may still get through.',
        actions: [retry, appLink('Get the app', 'btn-secondary')],
      });
    case 'no-direct':
      return showMessage({
        glyph: 'offline',
        title: 'Couldn’t connect directly to the sender',
        body: 'Files only ever travel straight from the sender’s computer to yours, never through a server, and the networks on both ends wouldn’t open a direct path this time. Try again, switch networks (a phone hotspot usually works), or ask the sender to enable UPnP on their router.',
        actions: [retry, appLink('Get the app', 'btn-secondary')],
      });
    case 'too-big': {
      const { needed, available } = err.cause || {};
      return showMessage({
        title: 'Too big for this browser',
        body: needed
          ? `This download is at least ${formatBytes(needed)}, and your browser can hold about ${formatBytes(available)}. The Enidor app downloads straight to disk, with no size limit.`
          : `This download is more than your browser can hold (about ${formatBytes(available)}). The Enidor app downloads straight to disk, with no size limit.`,
        actions: [appLink('Get Enidor'), backButton()],
        extra: openInAppSteps(),
      });
    }
    case 'storage':
      return showMessage({
        title: 'Your browser ran out of room',
        body: 'The download filled the space your browser allows this site. Free up disk space, or use the Enidor app, which saves straight to disk.',
        actions: [appLink('Get Enidor'), backButton()],
      });
    case 'stalled':
      return showMessage({
        title: 'The transfer stopped',
        body: 'The connection to the sender kept dropping, so the download was stopped. Try again, or use the Enidor app, which can resume later.',
        actions: [backButton('Try again', 'btn-primary'), appLink('Get the app', 'btn-secondary')],
      });
    case 'truncated':
      return showMessage({
        title: 'The folder download was cut off',
        body: 'The connection ended before the whole folder arrived, so the incomplete zip was discarded. Try again, or use the Enidor app.',
        actions: [retry, backButton()],
      });
    default:
      return showMessage({
        title: 'Something went wrong',
        body: 'The download couldn’t continue. Try again in a moment.',
        actions: [retry],
      });
  }
}

function backButton(label = 'Back to files', cls = 'btn-secondary') {
  return button(label, cls, () => renderListing());
}

function setHeadline() {
  ui.kicker.textContent = 'Shared with you on Enidor';
  const who = host || 'Someone';
  ui.title.textContent = listing && listing.room_name ? listing.room_name : (singleFile ? `${who} sent you a file.` : `${who} shared a folder with you.`);
  document.title = listing && listing.room_name ? `${listing.room_name} · Enidor` : `${who} shared ${singleFile ? 'a file' : 'a folder'} · Enidor`;
}

// ---------- listing ----------

function visibleFiles(list) {
  const files = (list.files || []).filter((f) => f && f.name && !OS_JUNK.has(f.name));
  return files.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function openFolder(subPath) {
  showStatus('Opening folder…');
  try {
    const list = await session.list(subPath);
    path = subPath;
    listing = list;
    renderListing();
  } catch (err) {
    showError(err);
  }
}

function crumbs() {
  const parts = path ? path.split('/').filter(Boolean) : [];
  const nodes = [button(host ? `${host}` : 'Shared folder', 'rx-crumb', () => openFolder(''), { disabled: parts.length === 0 })];
  parts.forEach((part, i) => {
    const target = parts.slice(0, i + 1).join('/');
    nodes.push(el('span', { class: 'rx-crumb-sep', 'aria-hidden': 'true' }, '›'));
    nodes.push(button(part, 'rx-crumb', () => openFolder(target), { disabled: i === parts.length - 1 }));
  });
  return el('nav', { class: 'rx-crumbs', 'aria-label': 'Folder' }, nodes);
}

function renderListing() {
  const files = visibleFiles(listing);

  if (singleFile) {
    showSingleFile(files[0]);
    return;
  }

  const rows = files.map((item) => {
    const size = item.is_dir ? '' : formatBytes(item.size);
    if (item.is_dir) {
      return el('li', null,
        el('button', { type: 'button', class: 'rx-row', onclick: () => openFolder(item.path) },
          icon('folder'),
          el('span', { class: 'rx-name' }, item.name)
        ),
      );
    }
    return el('li', null,
      el('button', { type: 'button', class: 'rx-row', onclick: () => showSingleFile(item) },
        icon(kindOf(item), kindOf(item) === 'file' ? '' : 'accent'),
        el('span', { class: 'rx-name', title: item.name }, item.name),
        el('span', { class: 'rx-size' }, size)
      ),
    );
  });

  const folderName = path ? path.split('/').filter(Boolean).pop() : (host || 'Shared Folder');
  const folderDownloadBtn = button('Download Folder', 'btn-primary btn-small', () => {
    startDownload({ name: folderName + '.zip', path: path, is_dir: true, size: 0 });
  });

  setCard(
    el('div', { class: 'rx-list-head' },
      crumbs(),
      folderDownloadBtn
    ),
    rows.length
      ? el('ul', { class: 'rx-files' }, rows)
      : el('p', { class: 'rx-empty' }, 'This folder is empty.')
  );
}

// ---------- previews ----------
//
// Shared content never runs in this page's origin. Only passive formats are previewed: images,
// audio and video (never autoplaying), PDF inside a fully sandboxed frame (no scripts, opaque
// origin), and text as text (textContent in a <pre>, never parsed as markup). Everything else
// gets a download button only.

function streamUrl(item) {
  return new URL(`./${SW_STREAM_PREFIX}/${STREAM_SESSION}/${encodeURIComponent(item.path)}`, location.href).href;
}

// src: a URL for media; readText: () => Promise<{ text, truncated }> for text previews.
function buildPreview(item, src, readText, { allowPdf = true } = {}) {
  const kind = previewKind(item.name);
  const noCopy = (e) => e.preventDefault();
  switch (kind) {
    case 'image':
      return el('img', { src, alt: item.name, class: 'rx-img', oncontextmenu: noCopy });
    case 'audio':
      return el('audio', { src, controls: true, preload: 'metadata', controlslist: 'nodownload', class: 'rx-audio', oncontextmenu: noCopy });
    case 'video': {
      const video = el('video', { src, controls: true, preload: 'metadata', playsinline: true, controlslist: 'nodownload', class: 'rx-media', oncontextmenu: noCopy });
      video.addEventListener('error', () => {
        video.replaceWith(el('div', { class: 'rx-preview-fallback' },
          icon('video', 'rx-big'),
          el('p', null, 'Your browser can’t preview this video format.'),
          el('p', { class: 'rx-note' }, 'Download the file to watch it.'),
        ));
      }, { once: true });
      return video;
    }
    case 'pdf':
      if (!allowPdf) return null;
      // sandbox="" : no scripts, no forms, no popups, opaque origin.
      return el('iframe', { src, sandbox: '', referrerpolicy: 'no-referrer', title: item.name, class: 'rx-frame' });
    case 'text': {
      if (!readText) return null;
      const pre = el('pre', { class: 'rx-text' }, 'Loading preview…');
      readText().then(({ text, truncated }) => {
        pre.textContent = truncated ? `${text}\n\n… (preview shows the first ${formatBytes(TEXT_PREVIEW_BYTES)})` : text;
      }, () => {
        pre.textContent = 'Preview unavailable. Download the file to open it.';
      });
      return pre;
    }
    default:
      return null;
  }
}

function decodeText(bytes, truncated) {
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated };
}

// Reads the start of a not-yet-downloaded file through the service worker.
function streamText(item) {
  return async () => {
    const res = await fetch(streamUrl(item), { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
    if (!res.ok) throw new Error(`preview responded ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return decodeText(bytes.subarray(0, TEXT_PREVIEW_BYTES), Number(item.size) > TEXT_PREVIEW_BYTES);
  };
}

function blobText(file) {
  return async () => decodeText(new Uint8Array(await file.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer()), file.size > TEXT_PREVIEW_BYTES);
}

// ---------- single file preview & downloading ----------

function riskyWarning(item) {
  return el('p', { class: 'rx-warning', role: 'note' },
    icon('alert'),
    el('span', null, `“${item.name}” is a type of file that can run programs or scripts on your computer. Only open it if you trust the sender and expected this file.`),
  );
}

function showSingleFile(item) {
  const risky = isRisky(item.name);
  // Streaming previews need the service worker to be in control of this page.
  const canStream = !!navigator.serviceWorker?.controller;
  // PDFs are only previewed from the finished download: a sandboxed frame can't be served by
  // the service worker.
  const preview = canStream ? buildPreview(item, streamUrl(item), streamText(item), { allowPdf: false }) : null;

  setCard(
    el('div', { class: `rx-single${preview ? ' rx-wide' : ''}` },
      !preview && icon(kindOf(item), 'rx-big accent'),
      el('h2', { class: 'rx-card-title' }, item.name),
      el('p', { class: 'rx-note' }, formatBytes(item.size)),
      risky && riskyWarning(item),
      preview ? el('div', { class: 'rx-preview' }, preview) : null,
      el('div', { class: 'rx-actions' },
        button(risky ? 'Download anyway' : 'Download', 'btn-primary', () => startDownload(item)),
        singleFile ? null : button('Back', 'btn-ghost', () => renderListing())
      )
    )
  );
}

async function startDownload(item) {
  if (transfer) return;

  discardStored();
  const total = Math.max(0, Number(item.size) || 0);
  const controller = new AbortController();
  transfer = { controller, sink: null };

  showStatus('Preparing…');
  let sink;
  try {
    sink = await openSink(total);
  } catch (err) {
    transfer = null;
    showError(err);
    return;
  }
  transfer.sink = sink;

  const isZip = !!item.is_dir;
  const batch = new Batcher(sink, isZip ? WRITE_BATCH_BYTES : total);
  const meter = new Meter(0);
  let received = 0;

  const bar = el('span');
  bar.style.width = '0%';
  const stats = el('p', { class: 'rx-stats' }, 'Connecting…');
  const note = el('p', { class: 'rx-note' }, 'Saving into your browser first — keep this tab open. You’ll choose where it goes when it’s done.');
  setCard(
    el('div', { class: 'rx-progress' },
      el('div', { class: 'rx-progress-head' },
        icon(kindOf(item), 'accent'),
        el('span', { class: 'rx-name', title: item.name }, item.name),
      ),
      el('div', { class: 'meter', role: 'progressbar', 'aria-label': `Downloading ${item.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar),
      stats,
      note,
      el('div', { class: 'rx-actions' }, button('Cancel', 'btn-ghost', () => controller.abort(new DOMException('cancelled', 'AbortError')))),
      el('p', { class: 'rx-nudge' }, 'Big file? ', el('a', { href: '../#releases', 'data-scroll': 'get-enidor' }, 'The Enidor app'), ' saves straight to disk with no size limit, and picks up where it left off.'),
    ),
  );

  let reconnecting = false;
  const paint = () => {
    const pct = total ? Math.min(100, (received / total) * 100) : (isZip ? 100 : 0);
    bar.style.width = isZip ? '100%' : `${pct}%`;
    if (isZip) bar.classList.add('pulse-bar');
    bar.parentElement.setAttribute('aria-valuenow', String(Math.floor(pct)));
    const speed = meter.speed();
    const parts = [isZip ? `${formatBytes(received)}` : `${formatBytes(received)} of ${formatBytes(total)}`];
    if (reconnecting || session.state === 'reconnecting') parts.push('reconnecting directly…');
    else if (speed > 0) {
      parts.push(`${formatBytes(speed)}/s`);
      if (!isZip) parts.push(formatEta((total - received) / speed));
    }
    if (!reconnecting && session.state === 'direct') parts.push('direct peer-to-peer');
    stats.textContent = parts.filter(Boolean).join(' · ');
    document.title = isZip ? `${formatBytes(received)} · ${item.name}` : `${Math.floor(pct)}% · ${item.name}`;
  };
  const painter = setInterval(paint, 250);

  const onBytes = (bytes) => {
    if (reconnecting) reconnecting = false;
    const room = isZip ? bytes.byteLength : total - received;
    if (room <= 0) return null;
    const chunk = (!isZip && bytes.byteLength > room) ? bytes.subarray(0, room) : bytes;
    // A folder has no size up front, so the in-memory cap is enforced as it arrives.
    if (sink.inMemory && received + chunk.byteLength > MEMORY_LIMIT_BYTES) {
      controller.abort(new ShareError('too-big', '', { needed: received + chunk.byteLength, available: MEMORY_LIMIT_BYTES }));
      return null;
    }
    const wait = batch.push(chunk);
    received += chunk.byteLength;
    meter.add(received);
    if (sink.error) controller.abort(new ShareError('storage', sink.error.message, sink.error));
    return wait;
  };

  try {
    if (isZip) {
      // A folder is zipped on the fly, so there's no length to check and no offset to resume
      // from: a stream error means the zip is incomplete, and a clean end is verified below.
      try {
        await session.fetchRange(item.path, 0, 0, onBytes, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (err instanceof ShareError) throw err;
        throw new ShareError('truncated', err?.message, err);
      }
    } else {
      await session.fetchAll(item.path, 0, total, onBytes, controller.signal, () => {
        reconnecting = true;
        paint();
      });
    }
    const last = batch.flush();
    if (last) await last;
    if (sink.error) throw new ShareError('storage', sink.error.message, sink.error);
    paint();
    const file = await sink.finish();
    if (!isZip && file.size !== total) throw new Error(`stored ${file.size} of ${total} bytes`);
    if (isZip && !(await zipLooksComplete(file))) {
      await removeStored(sink.name);
      throw new ShareError('truncated', `zip ended after ${file.size} bytes without its central directory`);
    }
    stored = { item, file, name: sink.name, url: null };
    transfer = null;
    showReady();
  } catch (err) {
    transfer = null;
    await sink.discard();
    setHeadline();
    if (err instanceof ShareError && (err.kind === 'truncated' || err.kind === 'stalled')) {
      err.retry = () => startDownload(item);
    }
    if (err?.name === 'AbortError') renderListing();
    else if (err?.name === 'QuotaExceededError' || err?.cause?.name === 'QuotaExceededError') showError(new ShareError('storage'));
    else showError(err);
  } finally {
    clearInterval(painter);
  }
}

// ---------- the finished file: save or discard ----------

function showReady() {
  const { item, file } = stored;
  document.title = `Ready · ${item.name}`;

  if (!stored.url) {
    // getMimeType never returns an active type (html, svg, js…), so even opened directly this
    // blob can't run script in our origin.
    const typedFile = new File([file], item.name, { type: getMimeType(item.name) });
    stored.url = URL.createObjectURL(typedFile);
  }

  const risky = isRisky(item.name);
  const preview = item.is_dir ? null : buildPreview(item, stored.url, blobText(file));

  setCard(
    el('div', { class: `rx-message${preview ? ' rx-wide' : ''}` },
      !preview && icon('check', 'rx-big ok'),
      el('h2', { class: 'rx-card-title' }, preview ? item.name : 'Download complete'),
      preview ? el('div', { class: 'rx-preview' }, preview) : null,
      !preview && el('p', { class: 'rx-card-body' }, el('strong', { class: 'rx-name' }, item.name), ` (${formatBytes(file.size)}) is ready in your browser. Save it to your computer?`),
      risky && riskyWarning(item),
      el('div', { class: 'rx-actions' },
        button(risky ? 'Save anyway' : 'Save to computer', 'btn-primary', saveStored),
        button(preview ? 'Close' : 'Discard', 'btn-ghost', () => {
          discardStored();
          renderListing();
        }),
      ),
    ),
  );
}

function saveStored() {
  const { item, file } = stored;
  const tempUrl = URL.createObjectURL(file);
  const a = el('a', { href: tempUrl, download: item.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(tempUrl), 1000);

  setCard(
    el('div', { class: 'rx-message' },
      icon('check', 'rx-big ok'),
      el('h2', { class: 'rx-card-title' }, 'Saved to your computer'),
      el('p', { class: 'rx-card-body' }, 'Your browser put ', el('strong', { class: 'rx-name' }, item.name), ' in your Downloads folder.'),
      el('div', { class: 'rx-actions' },
        singleFile ? null : button('Back to files', 'btn-primary', () => renderListing()),
        button('Save again', singleFile ? 'btn-primary' : 'btn-ghost', saveStored),
      ),
    ),
  );
}

// Deletes the browser's copy of a finished download. A saved copy is kept until the next download
// starts, because the browser may still be reading it into the Downloads folder; anything left
// behind is swept on a later visit.
function discardStored() {
  if (!stored) return;
  const { url, name } = stored;
  stored = null;
  if (url) URL.revokeObjectURL(url);
  removeStored(name);
}

// ---------- PIN-protected rooms ----------

const PIN_ERRORS = new Set(['pin_required', 'invalid_pin', 'wrong_pin']);
const PIN_LOCKED = new Set(['pin_locked', 'too_many_attempts']);

// "Too many wrong attempts" message with the host's wait time (retry_after, seconds) when given.
function lockedMessage(list) {
  const secs = Number(list?.retry_after) || 0;
  if (secs <= 0) return 'Too many wrong attempts. Wait a few minutes, then try again.';
  const mins = Math.ceil(secs / 60);
  const wait = mins >= 60 ? `${Math.ceil(mins / 60)} hour${mins > 60 ? 's' : ''}` : `${mins} minute${mins === 1 ? '' : 's'}`;
  return `Too many wrong attempts. Try again in ${wait}.`;
}

// Lists the room root, asking for a PIN while the host requires one. Resolves with the listing;
// rejects (to the caller's showError) if the connection fails.
function listWithPin() {
  return new Promise((resolve, reject) => {
    const ask = (problem) => {
      const input = el('input', {
        type: 'password', id: 'pin-input', class: 'rx-pin-input', inputmode: 'numeric',
        autocomplete: 'off', placeholder: 'Enter PIN', 'aria-label': 'PIN', required: true, maxlength: '64',
      });
      const submit = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Access files');
      const status = el('p', { class: 'rx-pin-error', role: 'alert' }, problem || '');
      status.hidden = !problem;
      const form = el('form', { class: 'rx-pin', novalidate: true },
        el('label', { for: 'pin-input', class: 'rx-card-body' }, 'This deployment is protected by a PIN.'),
        input,
        status,
        submit,
      );
      form.addEventListener('submit', async (evt) => {
        evt.preventDefault();
        if (!input.value) {
          input.focus();
          return;
        }
        submit.disabled = true;
        input.disabled = true;
        submit.textContent = 'Verifying…';
        status.hidden = true;
        session.pin = input.value;
        let list;
        try {
          list = await session.list('');
        } catch (err) {
          reject(err);
          return;
        }
        if (PIN_ERRORS.has(list?.error)) return ask('Wrong PIN. Check it with the sender and try again.');
        if (PIN_LOCKED.has(list?.error)) return ask(lockedMessage(list));
        if (list?.error) return reject(new ShareError('closed', String(list.error)));
        resolve(list);
      });
      setCard(
        el('div', { class: 'rx-message' },
          icon('alert', 'rx-big accent'),
          el('h2', { class: 'rx-card-title' }, 'PIN-protected share'),
          form,
        ),
      );
      input.focus();
    };

    session.list('').then((list) => {
      if (PIN_ERRORS.has(list?.error)) ask('');
      else if (PIN_LOCKED.has(list?.error)) ask(lockedMessage(list));
      else if (list?.error) reject(new ShareError('closed', String(list.error)));
      else resolve(list);
    }, reject);
  });
}

// ---------- boot ----------

// A line under the card that always says how we're connected to the sender.
const CONN_LABELS = {
  connecting: 'Connecting straight to the sender’s computer…',
  direct: 'Connected directly · peer-to-peer, encrypted end to end',
  reconnecting: 'Connection dropped · reconnecting directly…',
};

function renderConnState(state) {
  let line = document.getElementById('rx-conn');
  if (!line) {
    line = el('p', { id: 'rx-conn', class: 'rx-conn', role: 'status' });
    ui.card.after(line);
  }
  line.dataset.state = state;
  line.textContent = CONN_LABELS[state] || '';
  line.hidden = !CONN_LABELS[state];
}

function renderCode() {
  if (!code) return;
  ui.code.replaceChildren(...[...code].map((d) => el('span', null, d)));
  ui.code.setAttribute('aria-label', `Room code ${spacedCode(code)}`);
  ui.code.hidden = false;
}

async function main() {
  if (link.room) {
    await openReceivedRoom();
    return;
  }
  if (link.legacy) {
    ui.title.textContent = 'This link format is no longer supported.';
    ui.lede.textContent = 'Links with a 6-digit room code stopped working in the browser. Ask the sender for a new share link from the Enidor app.';
    showMessage({
      title: 'Ask the sender for a new link',
      body: 'Or enter the code in the Enidor app to open the room:',
      extra: openInAppSteps(),
      actions: [appLink('Get Enidor')],
    });
    return;
  }

  if (!link.id) {
    ui.title.textContent = 'This link is missing its ID.';
    ui.lede.textContent = 'Enidor share links end with a unique link ID. Ask the sender for the full link.';
    showMessage({
      title: 'Have a code instead?',
      body: 'Enter it in the Enidor app to open the room:',
      extra: openInAppSteps(),
      actions: [appLink('Get Enidor')],
    });
    return;
  }

  if (!config.signal || config.relays.length === 0) {
    showMessage({
      glyph: 'download',
      tone: 'accent',
      title: 'Open this room in the Enidor app',
      body: 'Downloading in the browser isn’t switched on for this room yet. The app gets you in:',
      extra: openInAppSteps(),
      actions: [appLink('Get Enidor')],
    });
    return;
  }

  showStatus('Resolving link…');
  try {
    const resolved = await resolveLink(config.signal, link.id);
    if (expectedPeer && expectedPeer !== resolved.peerId) {
      throw new ShareError('mismatch', 'link fragment and directory disagree about the sender');
    }
    expectedPeer = resolved.peerId;
    code = resolved.roomCode;
  } catch (err) {
    showError(err);
    return;
  }

  renderCode();
  sweepOldDownloads();
  showStatus('Finding the sender…', `Room ${spacedCode(code)}`);
  try {
    const peerId = await lookUp(config.signal, code);
    // The room record must point at the peer the link was made by; the connection itself is
    // then checked against that ID (Session.dialDirect).
    if (peerId !== expectedPeer) throw new ShareError('mismatch', 'room record points at a different peer');
    showStatus('Opening an encrypted tunnel…', 'Connecting straight to the sender’s computer.');
    session = new Session(code, expectedPeer, config.relays);
    session.onState = renderConnState;
    await session.start();
    // Connect before asking for the listing, so the listing's timeout doesn't cut the retries short.
    await session.connect();
    const list = await listWithPin();
    host = String(list.host_name || '').trim();
    // The app answers an unknown or closed room with an empty list, and an empty folder with none.
    if (Array.isArray(list.files) && list.files.length === 0) {
      throw new ShareError('closed');
    }
    const files = visibleFiles(list);
    singleFile = files.length === 1 && !files[0].is_dir;
    listing = list;
    path = '';
    setHeadline();
    renderListing();
  } catch (err) {
    showError(err);
  }
}

addEventListener('beforeunload', (evt) => {
  if (!transfer) return;
  evt.preventDefault();
  evt.returnValue = '';
});

addEventListener('hashchange', () => {
  const next = readLink();
  if (next.id !== link.id || next.peer !== link.peer || next.legacy !== link.legacy || next.room !== link.room) location.reload();
});

// Receive by QR: the sender answered our one-time code (see receive/ and the app's receive_qr.go).
async function openReceivedRoom() {
  if (!config.signal || config.relays.length === 0) {
    showMessage({ title: 'Receiving isn’t available here right now', body: 'Ask the sender to share a link from Enidor instead.', actions: [appLink('Get Enidor')] });
    return;
  }
  code = link.room;
  ui.title.textContent = 'Files sent to you';
  ui.lede.textContent = 'They come straight from the sender’s device, encrypted end to end. Nothing is uploaded to a cloud.';
  sweepOldDownloads();
  showStatus('Finding the sender…');
  try {
    // Whoever registered this code answered our QR; the connection is then checked against them.
    expectedPeer = await lookUp(config.signal, code);
    showStatus('Opening an encrypted tunnel…', 'Connecting straight to the sender’s device.');
    session = new Session(code, expectedPeer, config.relays);
    session.onState = renderConnState;
    session.pin = link.pin;
    await session.start();
    await session.connect();
    const list = await listWithPin();
    host = String(list.host_name || '').trim();
    if (Array.isArray(list.files) && list.files.length === 0) throw new ShareError('closed');
    const files = visibleFiles(list);
    singleFile = files.length === 1 && !files[0].is_dir;
    listing = list;
    path = '';
    setHeadline();
    renderListing();
  } catch (err) {
    showError(err);
  }
}

document.addEventListener('click', (evt) => {
  const target0 = evt.target.closest?.('[data-scroll]');
  const target = target0 && document.getElementById(target0.dataset.scroll);
  if (!target) return;
  evt.preventDefault();
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
});

// ---------- streaming previews through the service worker ----------

// Parses an HTTP Range header against a file of `size` bytes.
// Returns null to serve the whole file (no header, unknown size, or a multi-range request, which
// the spec lets us ignore), { start, end } (inclusive) for a satisfiable range, or 'invalid' (416).
function parseRange(header, size) {
  if (!header || !(size > 0)) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return /^\s*bytes\s*=.*,/i.test(header) ? null : 'invalid';
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  if (a === '') {
    const n = Number(b); // suffix: the last n bytes
    if (!(n > 0)) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  let end = b === '' ? size - 1 : Number(b);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

function serveStream(data, port) {
  const item = visibleFiles(listing || { files: [] }).find((f) => f.path === data.path);
  if (!item || item.is_dir || !session) {
    port.postMessage({ type: 'ENIDOR_STREAM_RESPONSE', status: 404, statusText: 'Not Found', headers: {}, stream: null });
    return;
  }
  const totalSize = Math.max(0, Number(item.size) || 0);
  const headers = {
    'Content-Type': getMimeType(item.name),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    // Even if this URL is opened directly, its content is sandboxed and can't run script.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' blob: data:; media-src 'self' blob:",
  };

  const range = parseRange(data.range, totalSize);
  if (range === 'invalid') {
    headers['Content-Range'] = `bytes */${totalSize}`;
    port.postMessage({ type: 'ENIDOR_STREAM_RESPONSE', status: 416, statusText: 'Range Not Satisfiable', headers, stream: null });
    return;
  }
  let status = 200;
  let start = 0;
  let length = totalSize;
  if (range) {
    status = 206;
    start = range.start;
    length = range.end - range.start + 1;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${totalSize}`;
  }
  if (totalSize > 0) headers['Content-Length'] = String(length);

  const abortController = new AbortController();
  // The player reads at playback speed. Only fetch ahead of it by STREAM_BUFFER_BYTES, so a
  // long video neither fills memory nor competes with what's about to be watched.
  let pulled = null;
  const stream = new ReadableStream({
    // Not awaited: the stream only calls pull() once start() has returned.
    start(controller) {
      (async () => {
        try {
          const enqueue = (chunk) => {
            controller.enqueue(chunk.slice());
            if (controller.desiredSize > 0) return null;
            return new Promise((resolve) => { pulled = resolve; });
          };
          if (length > 0) await session.fetchAll(item.path, start, length, enqueue, abortController.signal);
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      })();
    },
    pull() {
      pulled?.();
      pulled = null;
    },
    cancel() {
      abortController.abort(new DOMException('Stream cancelled', 'AbortError'));
      pulled?.();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: STREAM_BUFFER_BYTES }));

  port.postMessage({
    type: 'ENIDOR_STREAM_RESPONSE',
    status,
    statusText: status === 206 ? 'Partial Content' : 'OK',
    headers,
    stream,
  }, [stream]);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .catch((err) => console.error('SW registration failed:', err));

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    // Several share pages can be open at once; answer only requests made by this one.
    if (data?.type !== 'ENIDOR_STREAM_REQUEST' || data.session !== STREAM_SESSION) return;
    const port = event.ports[0];
    if (port) serveStream(data, port);
  });
}

main();
