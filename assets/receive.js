// The receive page (d/): downloads a Guest Room share straight from the sharer's computer.
//
// It speaks the same protocol as the desktop app (From_project_1/internal/core/node.go):
//   1. GET {signal}/{code}         → the sharer's relayed multiaddr; only its peer ID is used
//   2. dial {relay}/p2p-circuit/webrtc/p2p/{peer}: the relay (reached over WSS or WebTransport)
//      carries only a WebRTC handshake, then both sides hole-punch to a direct connection. If the
//      networks won't allow that, it falls back to {relay}/p2p-circuit/p2p/{peer}, through the relay.
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
const DIRECT_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 25_000;
const LISTING_TIMEOUT_MS = 45_000;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
const MAX_STALLED_ATTEMPTS = 8; // same as the app: give up after 8 retries in a row that moved no bytes
const WRITE_BATCH_BYTES = 4 * 1024 * 1024;
const MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024; // only used when the browser has no private file system
const OPFS_DIR = 'enidor-downloads';
const OPFS_STALE_MS = 60 * 60 * 1000;
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

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

// Share links look like d/#482913; d/?c=482913 and d/?code=482913 work too.
function readCode() {
  let hash = location.hash.slice(1);
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // leave it as typed
  }
  const params = new URLSearchParams(location.search);
  for (const raw of [hash, params.get('c'), params.get('code')]) {
    const digits = (raw || '').replace(/[\s.-]/g, '');
    if (/^\d{6}$/.test(digits)) return digits;
  }
  return null;
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
    this.kind = kind; // not-found | lookup-failed | offline | unreachable | closed | blocked | too-big | stalled | storage
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
    this.route = null; // 'direct' or 'relay'
    this.directBlocked = false;
  }

  async start() {
    const allowed = this.relays;
    this.node = await createLibp2p({
      transports: [webSockets(), webTransport(), webRTC(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      // The page only ever talks to the configured relays, and to the sharer through them.
      connectionGater: {
        denyDialMultiaddr: (ma) => !allowed.some((relay) => ma.toString().startsWith(relay)),
      },
    });
  }

  relayConnected() {
    return this.node.getConnections().some((c) => this.relayIds.has(c.remotePeer.toString()));
  }

  // Connects to the sharer: straight to their computer over WebRTC when the networks allow it,
  // otherwise through the relay. Each relay is tried in turn, the one that worked last first.
  async connect(signal) {
    if (this.conn?.status === 'open') return this.conn;
    const order = this.relays.map((_, i) => (i + this.preferred) % this.relays.length);
    let lastErr;
    for (const i of order) {
      for (const route of this.directBlocked ? ['relay'] : ['direct', 'relay']) {
        const hop = route === 'direct' ? '/webrtc' : '';
        const target = multiaddr(`${this.relays[i]}/p2p-circuit${hop}/p2p/${this.peerId}`);
        try {
          this.conn = await this.node.dial(target, {
            signal: withTimeout(signal, route === 'direct' ? DIRECT_TIMEOUT_MS : DIAL_TIMEOUT_MS),
            force: route === 'direct', // a relayed connection to the sharer may already exist
          });
          this.route = route;
          this.preferred = i;
          return this.conn;
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          lastErr = err;
          // A network that blocks hole punching will keep blocking it; don't wait on it again.
          if (route === 'direct') this.directBlocked = true;
        }
      }
    }
    const kind = this.relayConnected() ? 'offline' : 'unreachable';
    throw new ShareError(kind, lastErr?.message, lastErr);
  }

  // How many bytes a relayed connection may still carry, if the relay caps it.
  relayAllowance() {
    const bytes = this.route === 'relay' ? this.conn?.limits?.bytes : null;
    return bytes == null ? Infinity : Number(bytes);
  }

  async open(protocol, signal) {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connect(signal);
      try {
        return await conn.newStream(protocol, {
          signal: withTimeout(signal, DIAL_TIMEOUT_MS),
          // Relayed connections are "limited" when the relay caps them; the page resumes if one is cut.
          runOnLimitedConnection: true,
        });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (conn.status === 'open' || attempt > 0) throw err;
        this.conn = null; // it closed under us; connect again
      }
    }
  }

  async list(subPath) {
    const signal = AbortSignal.timeout(LISTING_TIMEOUT_MS);
    const stream = await this.open(PROTOCOL_META, signal);
    const reading = readAll(stream, signal); // listen before asking, so no reply can slip past
    stream.send(encoder.encode(`${this.code}\n${subPath}\n${this.guest}\n`));
    closeWrite(stream);
    return JSON.parse(decoder.decode(await reading));
  }

  // Streams [offset, offset + length) of a file into onBytes. Resolves when the sharer closes the
  // stream, which may be early if the connection drops; the caller resumes from what it got.
  async fetchRange(path, offset, length, onBytes, signal) {
    const stream = await this.open(PROTOCOL_DATA, signal);
    const head = encoder.encode(`${this.code}\n${path}\n${this.guest}\ndownload\n`);
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
          for (const bytes of segments(chunk)) onBytes(bytes);
        }
      })();
      stream.send(request);
      closeWrite(stream);
      await reading;
    } finally {
      signal.removeEventListener('abort', abort);
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
  if (!res.ok) throw new ShareError('lookup-failed', `directory responded ${res.status}`);
  const addr = (await res.text()).trim();
  const peerId = addr.split('/p2p/').pop();
  if (!addr.includes('/p2p/') || !/^[1-9A-HJ-NP-Za-km-z]{40,80}$/.test(peerId)) {
    throw new ShareError('lookup-failed', 'invalid room record');
  }
  return peerId;
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
    };
  }

  call(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  // Takes ownership of buffer (it's transferred to the worker).
  write(buffer, length, at) {
    this.worker.postMessage({ op: 'write', buffer: buffer.buffer, length, at }, [buffer.buffer]);
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
  }

  write(buffer, length) {
    this.parts.push(buffer.subarray(0, length));
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

  push(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const n = Math.min(bytes.length - offset, this.size - this.length);
      this.buffer.set(bytes.subarray(offset, offset + n), this.length);
      this.length += n;
      offset += n;
      if (this.length === this.size) this.flush();
    }
  }

  flush() {
    if (!this.length) return;
    this.sink.write(this.buffer, this.length, this.at);
    this.at += this.length;
    this.buffer = new Uint8Array(this.size);
    this.length = 0;
  }
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
const code = readCode();
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
  const retry = button('Try again', 'btn-primary', () => location.reload());
  const kind = err instanceof ShareError ? err.kind : 'unknown';
  if (kind === 'not-found' || kind === 'closed') {
    ui.title.textContent = 'This share isn’t available.';
    ui.lede.hidden = true;
  }
  switch (kind) {
    case 'not-found':
      return showMessage({
        title: 'No share uses this code',
        body: `Nothing is being shared under ${spacedCode(code)}. The link may be mistyped, or the room was never opened. Ask the sender to check the code.`,
      });
    case 'closed':
      return showMessage({
        title: 'This room is closed',
        body: 'The sender stopped sharing this folder, or it’s no longer on their computer. Ask them to share it again.',
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
    case 'blocked':
      return showMessage({
        glyph: 'offline',
        title: 'Your network blocks direct connections',
        body: 'Files come straight from the sender’s computer, and the network you’re on won’t allow a direct link to it. Try another network, like a phone hotspot, or open the room in the Enidor app.',
        actions: [appLink('Get Enidor'), backButton()],
      });
    case 'too-big': {
      const { needed, available } = err.cause || {};
      return showMessage({
        title: 'Too big for this browser',
        body: `This file is ${formatBytes(needed)}, and your browser can hold about ${formatBytes(available)}. The Enidor app downloads straight to disk, with no size limit.`,
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
  ui.title.textContent = singleFile ? `${who} sent you a file.` : `${who} shared a folder with you.`;
  document.title = `${who} shared ${singleFile ? 'a file' : 'a folder'} · Enidor`;
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
    const item = files[0];
    setCard(
      el('div', { class: 'rx-single' },
        icon(kindOf(item), 'accent rx-big'),
        el('h2', { class: 'rx-card-title rx-name' }, item.name),
        el('p', { class: 'rx-card-body' }, formatBytes(item.size)),
        el('div', { class: 'rx-actions' },
          button('Download', 'btn-primary', () => startDownload(item)),
        ),
        el('p', { class: 'rx-note' }, 'Downloads into your browser first, then asks where to save it.'),
      ),
    );
    return;
  }

  const rows = files.map((item) => {
    const size = item.is_dir ? '' : formatBytes(item.size);
    if (item.is_dir) {
      return el('li', null,
        el('button', { type: 'button', class: 'rx-row', onclick: () => openFolder(item.path) },
          icon('folder'),
          el('span', { class: 'rx-name' }, item.name),
          icon('chevron', 'rx-chevron'),
        ),
      );
    }
    return el('li', null,
      el('div', { class: 'rx-row' },
        icon(kindOf(item), kindOf(item) === 'file' ? '' : 'accent'),
        el('span', { class: 'rx-name', title: item.name }, item.name),
        el('span', { class: 'rx-size' }, size),
        button('Download', 'btn-secondary btn-small', () => startDownload(item), { 'aria-label': `Download ${item.name}` }),
      ),
    );
  });

  setCard(
    crumbs(),
    rows.length
      ? el('ul', { class: 'rx-files' }, rows)
      : el('p', { class: 'rx-empty' }, 'This folder is empty.'),
  );
}

// ---------- downloading ----------

async function startDownload(item) {
  if (transfer) return;
  discardStored();
  const total = Math.max(0, Number(item.size) || 0);
  if (total > session.relayAllowance()) {
    showError(new ShareError('blocked'));
    return;
  }
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

  const batch = new Batcher(sink, total);
  const meter = new Meter(0);
  let received = 0;

  const bar = el('span', { style: 'width:0%' });
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
    const pct = total ? Math.min(100, (received / total) * 100) : 100;
    bar.style.width = `${pct}%`;
    bar.parentElement.setAttribute('aria-valuenow', String(Math.floor(pct)));
    const speed = meter.speed();
    const parts = [`${formatBytes(received)} of ${formatBytes(total)}`];
    if (reconnecting) parts.push('reconnecting…');
    else if (speed > 0) parts.push(`${formatBytes(speed)}/s`, formatEta((total - received) / speed));
    if (!reconnecting && session.route) parts.push(session.route === 'direct' ? 'direct' : 'via relay');
    stats.textContent = parts.filter(Boolean).join(' · ');
    document.title = `${Math.floor(pct)}% · ${item.name}`;
  };
  const painter = setInterval(paint, 250);

  const onBytes = (bytes) => {
    if (reconnecting) reconnecting = false;
    const room = total - received;
    if (room <= 0) return;
    const chunk = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
    batch.push(chunk);
    received += chunk.byteLength;
    meter.add(received);
    if (sink.error) controller.abort(new ShareError('storage', sink.error.message, sink.error));
  };

  try {
    let stalled = 0;
    let lastErr = null;
    while (received < total) {
      const before = received;
      try {
        await session.fetchRange(item.path, received, total - received, onBytes, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw controller.signal.reason;
        lastErr = err;
      }
      if (received >= total) break;
      stalled = received > before ? 0 : stalled + 1;
      if (stalled >= MAX_STALLED_ATTEMPTS) {
        throw lastErr instanceof ShareError && lastErr.kind !== 'offline'
          ? lastErr
          : new ShareError('stalled', lastErr?.message, lastErr);
      }
      reconnecting = true;
      paint();
      await sleep(1000, controller.signal);
    }
    batch.flush();
    if (sink.error) throw new ShareError('storage', sink.error.message, sink.error);
    paint();
    const file = await sink.finish();
    if (file.size !== total) throw new Error(`stored ${file.size} of ${total} bytes`);
    stored = { item, file, name: sink.name, url: null };
    transfer = null;
    showReady();
  } catch (err) {
    transfer = null;
    await sink.discard();
    setHeadline();
    if (err?.name === 'AbortError') renderListing();
    else if (err?.name === 'QuotaExceededError' || err?.cause?.name === 'QuotaExceededError') showError(new ShareError('storage'));
    else showError(err);
  } finally {
    clearInterval(painter);
  }
}

// ---------- the finished file: save or discard ----------

function showReady() {
  const { item } = stored;
  document.title = `Ready · ${item.name}`;
  setCard(
    el('div', { class: 'rx-message' },
      icon('check', 'rx-big ok'),
      el('h2', { class: 'rx-card-title' }, 'Download complete'),
      el('p', { class: 'rx-card-body' },
        el('strong', { class: 'rx-name' }, item.name), ` (${formatBytes(item.size)}) is ready in your browser. Save it to your computer?`),
      el('div', { class: 'rx-actions' },
        button('Save to computer', 'btn-primary', saveStored),
        button('Discard', 'btn-ghost', () => {
          discardStored();
          renderListing();
        }),
      ),
    ),
  );
}

function saveStored() {
  const { item, file } = stored;
  stored.url ??= URL.createObjectURL(file);
  const a = el('a', { href: stored.url, download: item.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();

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

// ---------- boot ----------

function renderCode() {
  if (!code) return;
  ui.code.replaceChildren(...[...code].map((d) => el('span', null, d)));
  ui.code.setAttribute('aria-label', `Room code ${spacedCode(code)}`);
  ui.code.hidden = false;
}

async function main() {
  renderCode();

  if (!code) {
    ui.title.textContent = 'This link is missing its code.';
    ui.lede.textContent = 'Enidor share links end with the 6-digit room code, like …/d/#482913. Ask the sender for the full link.';
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

  sweepOldDownloads();
  showStatus('Finding the sender…', `Room ${spacedCode(code)}`);
  try {
    const peerId = await lookUp(config.signal, code);
    showStatus('Opening an encrypted tunnel…', 'Connecting straight to the sender’s computer.');
    session = new Session(code, peerId, config.relays);
    await session.start();
    const list = await session.list('');
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
  const next = readCode();
  if (next && next !== code) location.reload();
});

document.addEventListener('click', (evt) => {
  const link = evt.target.closest?.('[data-scroll]');
  const target = link && document.getElementById(link.dataset.scroll);
  if (!target) return;
  evt.preventDefault();
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
});

main();
