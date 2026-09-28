# hermesnetdev

Marketing site for **Enidor** — the sovereign private mesh — served with GitHub Pages from the
`main` branch.

Plain static site, no build step and no external dependencies (the type is the system font
stack, so nothing is fetched at runtime):

- `index.html`: the page
- `assets/style.css`: design system — tokens, light/dark themes, and sections that stay dark in
  both themes via the `.dark` class
- `assets/app.js`: loads releases live from [hermesnetdev/From_project_1_releases](https://github.com/hermesnetdev/From_project_1_releases/releases)
- `assets/ui.js`: reveal-on-scroll for sections marked `data-reveal`
- `assets/appicon.png`: the app icon — favicon, Apple touch icon, Open Graph image, and the
  tile in the download band
- `assets/mark.png`: the same mark cropped tight on transparency, used as the header logo and
  inverted by CSS in dark mode
- `assets/og.jpg`: the 2400×1260 share card used by every link preview
- `d/index.html`: the receive page. It downloads a Guest Room share in the browser (see below)
- `assets/receive.js`, `assets/receive-worker.js`, `assets/receive.css`: the receive page's
  logic, its disk writer, and its styles
- `assets/vendor/libp2p.js`: a pinned, prebuilt js-libp2p bundle, used only by the receive page
- `tools/libp2p-bundle`: the recipe for that bundle. It isn't served
- `.nojekyll`: tells GitHub Pages to serve the files as-is

## Product shots

The screenshots on the page are built in HTML and CSS rather than exported as images — the app
window (`.mock`), the chat and Micro-Room card (`.chat` / `.attach`), the activity monitor
(`.gauges` / `.log`) and the ecosystem diagram (inline SVG). They pick up theme tokens
automatically and stay crisp at any zoom. Replace them with real captures when there are some.

## Releases

The release list and download buttons come from the GitHub Releases API in the visitor's
browser, so a newly published release shows up on the site without redeploying. Assets are
matched to a platform by file name (`darwin`/`.dmg` → macOS, `windows`/`.exe` → Windows,
`linux`/`.AppImage` → Linux), so renaming the binaries doesn't break anything.
Responses are cached in `localStorage` for 10 minutes. If GitHub can't be reached, the page
shows the visitor's last cached list, or links to the releases page.

To point the site at another releases repo, change `REPO` at the top of `assets/app.js`.

## Preview locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Link previews

The `<head>` carries Open Graph (LinkedIn, Facebook, WhatsApp, Slack, Discord, Telegram,
iMessage), Twitter/X card tags, icon and platform-chrome tags, and a `SoftwareApplication`
JSON-LD block for Google rich results.

Every absolute URL in those tags points at `https://hermesnetdev.github.io/hermesnetdev/`.
**If the site moves to a custom domain, update those URLs** — `og:url`, `og:image`,
`og:image:secure_url`, `twitter:image`, `canonical`, and the `url`/`image` fields in the JSON-LD.

`assets/og.jpg` is 2400×1260 — retina-sharp at the 1200-wide size every platform displays —
and 197 KB, which keeps it under the ~300 KB ceiling where WhatsApp and Telegram stop
generating previews. It was rendered from a small standalone HTML card in a headless browser
rather than drawn by hand, so it can be regenerated whenever the tagline changes.

After changing any of this, re-scrape the caches so the old preview stops showing:

- LinkedIn — <https://www.linkedin.com/post-inspector/>
- Facebook / WhatsApp — <https://developers.facebook.com/tools/debug/>
- X — <https://cards-dev.twitter.com/validator>
- Google rich results — <https://search.google.com/test/rich-results>

Twitter/X `site` and `creator` handles are not set; add `twitter:site` and `twitter:creator`
if the project gets an account.

## Receive page

`d/` lets someone download a Guest Room share without installing anything. A share link is
the page plus the room's 6-digit code:

```
https://hermesnetdev.github.io/hermesnetdev/d/#482913
```

`d/?c=482913` and `d/?code=482913` work too. The hash form keeps the code out of server logs and
`Referer` headers. The page reads the code only from the URL. There's no box to type one in.

### How it works

The page is a small libp2p peer. It speaks the same protocol as the desktop app
(`From_project_1/internal/core/node.go`):

1. `GET {signal}/{code}` asks the room directory which peer hosts the code. Only the peer ID
   is used from the answer.
2. It connects **straight to the sharer's computer over WebRTC**:
   `{relay}/p2p-circuit/webrtc/p2p/{peer}`. The relay carries only the WebRTC handshake (an
   offer, an answer, and each side's addresses, a few KB). Then both sides hole-punch through
   their routers, the same trick two desktop apps use with each other, and the file moves
   directly. The desktop app answers the handshake with `internal/core/webrtc` in
   From_project_1.
3. If that fails, because the network blocks hole punching or the sharer runs an older app
   without WebRTC, it falls back to going through the relay: `{relay}/p2p-circuit/p2p/{peer}`.
   Both routes are encrypted end to end, so the relay can't read what it carries. When the
   relay caps what a connection may carry and the file is bigger than that, the page says the
   network blocks direct connections, instead of crawling.
4. `/streamfs/meta/1.2.0` lists the folder, and visitors can open subfolders.
5. `/streamfs/data/1.2.0` streams the file with an offset and length. If the connection drops,
   the page reconnects and resumes from the last byte it received, the same way the app does.
   It gives up after 8 attempts in a row that move no data.

Bytes are written into the browser's private file system (OPFS) as they arrive, from a
worker, so large files go to disk instead of memory. When the file is complete, the page
asks whether to **Save to computer** (a normal browser download) or **Discard** it. Browsers
without OPFS keep the download in memory, up to 1 GB. The page checks the browser's storage
quota before it starts, and suggests the app when a file won't fit.

The sharer sees the visitor as `Web guest · Chrome on macOS` (or similar) in their Activity
Monitor and audit log.

The rest of the page promotes the app. It has a browser-vs-app comparison, and download
buttons that `app.js` fills in from the latest release.

### Configuration

The `enidor-config` block in `d/index.html`:

```json
{
  "signal": "https://relay.example.com/room",
  "relays": ["/dns4/relay.example.com/tcp/443/wss/p2p/12D3KooWECv999C2QCGZ34TN2bWMDmMoKERL8EUDcEDud24u6eJ2"]
}
```

While either field is empty, the page doesn't try to connect. It shows the code and walks
the visitor through opening it in the app instead (**Join a Guest Room**). **It ships
empty**, because the current servers can't be reached from a browser yet:

### What the servers need first

Checked against the live server (`148.113.58.51`) on 2026-09-28. The signaling server already
does its part: it sends CORS headers for `https://hermesnetdev.github.io`, requires the
`X-Enidor-Auth` header, and has endpoints for a WebRTC handshake
(`POST /room/{code}/offer`, `GET /room/{code}/offers`, `POST|GET /room/{code}/answer`).

The relay's peer ID is now `12D3KooWECv999C2QCGZ34TN2bWMDmMoKERL8EUDcEDud24u6eJ2`. It changes
on every restart unless the relay saves its key, and an app built against an old one can't reach
the mesh at all.

Two things are still missing, and either one on its own makes the page work:

1. **A transport browsers can dial.** The relay listens only on raw TCP and QUIC
   (`/tcp/4001`, `/udp/4001/quic-v1`), and browsers can open neither. Add a WebSocket
   listener and put TLS in front of it on a domain. For example, in the relay:

   ```go
   libp2p.ListenAddrStrings(
       "/ip4/0.0.0.0/udp/4001/quic-v1",
       "/ip4/0.0.0.0/tcp/4001",
       "/ip4/127.0.0.1/tcp/4003/ws", // browsers, through the TLS proxy below
   ),
   ```

   WebTransport (`/udp/…/quic-v1/webtransport`) needs no domain and the bundle supports it. But
   its certificate hash rotates, so its address can't be hard-coded here.

   With this, the page connects the way it does today: the relay carries a WebRTC handshake,
   then the browser and the app hole-punch to a direct connection.

2. **Or a WebRTC handshake over the signaling endpoints**, which already exist. The browser
   posts its offer, the app polls for it and posts an answer, and the two connect directly.
   The relay then isn't involved in browser downloads at all. This needs the app to answer
   those offers, and the page to use them instead of libp2p.

Either way, **`:4002` has to be reachable over HTTPS**, because a page on `https://` may not
call `http://`. That needs a domain: certificates aren't issued for bare IP addresses. The
relay can fetch its own certificate with `golang.org/x/crypto/acme/autocert`, or sit behind
Caddy:

```
relay.example.com {
	handle /room/* {
		header Access-Control-Allow-Origin *
		reverse_proxy 127.0.0.1:4002
	}
	handle {
		reverse_proxy 127.0.0.1:4003
	}
}
```

The relay's limits can stay as they are. It hands out go-libp2p's defaults, 128 KiB and
2 minutes per relayed connection, which is plenty for a WebRTC handshake. They only matter for
the fallback: on a network that blocks hole punching, files bigger than the cap can't come
through the relay. Raising `relay.Resources.Limit` would let them, at the cost of relay
bandwidth for every such download.

The desktop app needs the WebRTC support in From_project_1 (`internal/core/webrtc`, switched
on in `internal/core/node.go`). Apps without it still work, through the fallback. One small
addition would help: a **Copy web link** button next to the room code, copying
`…/d/#<code>`.

### Updating the libp2p bundle

`assets/vendor/libp2p.js` is built from `tools/libp2p-bundle` (js-libp2p with WebSockets,
WebTransport, WebRTC, circuit relay, Noise and Yamux, pinned in `package-lock.json`):

```sh
cd tools/libp2p-bundle
npm ci && npm run build
```

It's about 630 KB minified, or 177 KB gzipped as GitHub Pages serves it. Only `d/` loads it.

### Testing the receive page locally

The test rig lives in From_project_1, because it runs the app's own WebRTC code. It starts a
relay with a WebSocket listener, a room directory, and a sharer that serves folders over the
app's protocol:

```sh
cd From_project_1
go run ./cmd/receive-harness -rooms 123456=/path/to/a/folder
```

Copy the printed `SIGNAL` and `RELAY_WS` into `enidor-config` (in a copy of the site, or
temporarily), serve the site with `python3 -m http.server 8000`, and open
`http://localhost:8000/d/#123456`.

The rig's relay uses the same 128 KiB limit as production, so a big file only finishes if it
went over WebRTC. Its log shows `via=webrtc` for each request that did. Useful flags:
- `-webrtc=false` exercises the relay fallback. Add `-limit-data 0` to lift the relay's cap.
- `-drop-first 7340032` cuts the first transfer at 7 MB, to exercise resume.
- `-v` logs the WebRTC handshake.

Codes `111111` (closed room) and `222222` (sharer offline) are there to try the error states.
