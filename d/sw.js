// Serves /d/--enidor-stream--/<session>/<path> by asking the page that owns <session> to stream the
// bytes from the sharer (see serveStream in assets/receive.js). Video, audio and image previews
// use these URLs so the browser can seek with Range requests.
//
// A request is only ever answered by the page whose session ID is in the URL — never by some other
// open share page — so one share can't be served (or spoofed) from another.

const PREFIX = '/--enidor-stream--/';
const ANSWER_TIMEOUT_MS = 15_000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function parseStreamUrl(url) {
  const at = url.pathname.indexOf(PREFIX);
  if (at < 0) return null;
  const rest = url.pathname.slice(at + PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const session = rest.slice(0, slash);
  if (!/^[0-9A-Za-z-]{8,64}$/.test(session)) return null;
  try {
    return { session, path: decodeURIComponent(rest.slice(slash + 1)) };
  } catch {
    return null;
  }
}

function errorResponse(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
}

// The clients that could own the request, most likely first: the requesting page, the page a
// navigation is creating, then every other window (each checks the session ID itself).
async function candidates(event) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const ids = [event.clientId, event.resultingClientId].filter(Boolean);
  const first = ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  return [...first, ...all.filter((c) => !first.includes(c))];
}

async function handle(event, target) {
  const clients = await candidates(event);
  if (clients.length === 0) return errorResponse(503, 'no page to serve this stream');

  return new Promise((resolve) => {
    let done = false;
    const finish = (response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => finish(errorResponse(504, 'stream not answered')), ANSWER_TIMEOUT_MS);

    for (const client of clients) {
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => {
        if (data?.type === 'ENIDOR_STREAM_RESPONSE') {
          finish(new Response(data.stream, { status: data.status, statusText: data.statusText, headers: data.headers }));
        } else if (data?.type === 'ENIDOR_STREAM_ERROR') {
          finish(errorResponse(502, String(data.error || 'stream failed')));
        }
      };
      client.postMessage({
        type: 'ENIDOR_STREAM_REQUEST',
        session: target.session,
        path: target.path,
        range: event.request.headers.get('Range'),
      }, [channel.port2]);
    }
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const target = parseStreamUrl(url);
  if (!target) {
    if (url.pathname.includes(PREFIX)) event.respondWith(errorResponse(400, 'bad stream URL'));
    return;
  }
  event.respondWith(handle(event, target));
});
