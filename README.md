# hermesnetdev

Marketing site for **Enidor** — the sovereign private mesh — served with GitHub Pages from the
`main` branch.

Plain static site, no build step and no external dependencies (the type is the system font
stack, so nothing is fetched at runtime apart from Google AdSense, once it's switched on):

- `index.html`: the home page
- `help/`, `about/`, `privacy/`: the help/FAQ, about-and-contact, and privacy policy pages
- `assets/style.css`: design system — tokens, light/dark themes, and sections that stay dark in
  both themes via the `.dark` class
- `assets/app.js`: loads releases live from [hermesnetdev/From_project_1_releases](https://github.com/hermesnetdev/From_project_1_releases/releases)
- `assets/ui.js`: the footer year, and reveal-on-scroll for sections marked `data-reveal`
- `assets/ads.js`: fills the Google AdSense placements with ad units (see [Ads](#ads))
- `ads.txt`, `robots.txt`, `sitemap.xml`: for ad networks and search crawlers
- `CNAME`: the custom domain, `enidor.com`
- `googlefef17e26addffc31.html`: Google Search Console's ownership check. Keep it
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

Every absolute URL in those tags points at `https://enidor.com/`. **If the domain changes,
update those URLs** in every page — `og:url`, `og:image`, `og:image:secure_url`,
`twitter:image`, `canonical`, and the `url`/`image` fields in the JSON-LD — and in
`sitemap.xml` and `robots.txt`.

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

## Ads

Every page carries Google AdSense (publisher ID `ca-pub-8298378592499092`). Each has Google's
AdSense tag in its `<head>`, and `assets/ads.js` fills its ad placements.

**Ads on the receive page (`d/`) are a trade-off.** Ad code runs with the same access as the
page's own code. There, it could read the share link, the PIN as it's typed, and the shared
files themselves (by asking `d/sw.js` to stream them). The page says it shows ads and points
to the app, which has none, and the privacy policy says what the ad code can see. To keep
shares away from ad code, serve the receiver from another subdomain (say `files.enidor.com`)
in a frame on `d/`, with the ads outside the frame.

### Setup

- The site is verified with the **AdSense code snippet**, the tag in the home page's `<head>`.
  `ads.txt` lists the same publisher ID; GitHub Pages serves it at `https://enidor.com/ads.txt`.
- In **Privacy & messaging**, publish the **European regulations** message. Without a
  certified consent message, visitors from the EEA, UK and Switzerland don't get
  personalized ads.

### Placing ads

After approval, create display ad units (**Ads → By ad unit**) and put their IDs in `SLOTS` in
`assets/ads.js`. Placements are `<aside class="ad" data-ad="…">` elements in the pages:
`home-1`, `home-2`, `help-1`, `help-2`, `about-1`, `privacy-1`, `receive-1` and `receive-2`.
Each uses its own unit if `SLOTS` has
one, otherwise `SLOTS.default`. A placement with no unit, or one AdSense leaves unfilled,
stays hidden.

The placements sit between content sections, away from download buttons. AdSense doesn't
allow ads that could be mistaken for download links. If you switch on **Auto ads** as well,
exclude the hero and the releases section in its settings for the same reason.

Pages that aren't `enidor.com` (a local preview, say) request test ads, so they don't count
as impressions.

Adding a page: link it from the footers and add it to `sitemap.xml`. To give it ads, copy the
AdSense tag and the `assets/ads.js` line from the home page's `<head>`, and add a placement.

## Receive page

`d/` lets someone download a Guest Room share without installing anything. A share link is
the page plus a 128-bit link ID that the app creates with **Copy web link**
(`POST /link/create/{code}` on the relay):

```
https://enidor.com/d/?link=3f9c0e…(32 hex chars)
https://enidor.com/d/?link=3f9c0e…#peer=12D3KooW…   (optional pin to the sharer)
```

`d/#<link id>` works too. The page reads the link only from the URL; there's no box to type one in.

**Old 6-digit links (`d/#482913`) are no longer supported** in the browser: six digits can be
enumerated, so the page no longer resolves room codes. It recognises the old format and tells
the visitor to ask the sender for a new link (or to enter the code in the app).

### How it works

The page is a small libp2p peer. It speaks the same protocol as the desktop app
(`From_project_1/internal/core/node.go`):

1. `GET {signal-base}/link/resolve/{id}` (15 s timeout) turns the link into the room code and the
   **sharer's peer ID**, which the relay recorded from the sharer's signed request. If the link
   has a `#peer=` fragment, the two must agree. `GET {signal}/{code}` then returns the room's
   address, and its peer ID must be the same one. After connecting, the page checks that the
   Noise-authenticated remote peer (`connection.remotePeer`) is that ID, and stops with "This
   link doesn't lead to its sender" otherwise, so a tampered directory can't redirect visitors to
   another computer.
2. It connects **straight to the sharer's computer over WebRTC**:
   `{relay}/p2p-circuit/webrtc/p2p/{peer}`. The relay carries only the WebRTC handshake (an
   offer, an answer, and each side's addresses, a few KB). Then both sides hole-punch through
   their routers, the same trick two desktop apps use with each other, and the file moves
   directly. The desktop app answers the handshake with `internal/core/webrtc` in
   From_project_1.
3. **File data never goes through the relay.** The page only opens streams on a connection it
   has checked is WebRTC (not a relay circuit, not limited), closes the relayed connection to the
   sharer once the direct one is up, and gives WebRTC only STUN servers, never TURN. If no direct
   path opens after three attempts (20 s, 30 s, 45 s, with backoff), the page says so instead of
   falling back. The app enforces the same rule: it refuses any request that arrives over a relayed
   connection (`handleDirect` in `internal/core/node.go`).

   To make direct connections work on more networks, the app gathers its WebRTC candidates on
   one shared UDP port and one ICE-TCP port, and maps both on the router with UPnP or NAT-PMP
   when the router allows it (`internal/core/webrtc/reachability.go`). A mapped port is reachable
   even from a browser behind a symmetric NAT, and ICE-TCP gets through networks that block UDP.
   Without either, the two networks must allow hole punching; two symmetric NATs can't connect
   without a TURN relay, which this design rules out.

   If the direct connection drops, the page reconnects straight away and downloads and video
   previews resume from the last byte received. The line under the card shows the connection's
   state live.
4. `/streamfs/meta/1.2.0` lists the folder, and visitors can open subfolders.
5. `/streamfs/data/1.2.0` streams the file with an offset and length. If the connection drops,
   the page reconnects and resumes from the last byte it received, the same way the app does.
   It gives up after 8 attempts in a row that move no data. Video and audio previews read ahead
   at most 16 MB, so the sender only sends as fast as the player plays.

The app keeps up to 2 MiB in flight per stream (`sendWindow` in
`internal/core/webrtc/stream_write.go`). go-libp2p's default, 32 KiB, limits a download to about
0.5 MB/s at a 50 ms round trip however fast the link is. `throughput_test.go` measures it over
simulated links.

Bytes are written into the browser's private file system (OPFS) as they arrive, from a
worker, in 4 MB batches; when more than 32 MB is waiting for the worker, the page stops reading
from the network until the disk catches up. When the file is complete, the page asks whether to
**Save to computer** (a normal browser download) or **Discard** it. Browsers without OPFS keep
the download in memory, up to 1 GB (folders included: their size isn't known up front, so the cap
is enforced as bytes arrive). The page checks the browser's storage quota before it starts, and
suggests the app when a file won't fit.

Folders download as a zip made on the fly, with no length up front. A stream error is reported as
a failed download (with **Try again**), and a clean end is only accepted if the zip ends with its
end-of-central-directory record; otherwise the partial zip is discarded.

### Security

- **Shared content never runs in this origin.** Previews are limited to images, audio and video
  (no autoplay), PDF in an `<iframe sandbox="">` (no scripts, opaque origin; after download only),
  and text shown as text (`textContent` in a `<pre>`). HTML, SVG, XML and JS are shown as text.
  Everything else gets a download button only. Blob and stream responses never carry an active
  MIME type, and stream responses add `Content-Security-Policy: sandbox` and `nosniff`.
- **Executables and scripts** (`.exe .msi .ps1 .vbs .js .jar .dmg .pkg .deb .apk .html .svg .lnk
  .reg .hta …`) show a warning before download; they aren't blocked.
- **CSP** (`<meta http-equiv="Content-Security-Policy">` in `d/index.html` and `index.html`):
  `script-src 'self'`, no inline scripts; `d/` also has no inline styles. `connect-src` allows
  only the signaling directory (`https://*.libp2p.direct:5443`), the relay's WSS
  (`wss://*.libp2p.direct:5003`) and the GitHub API. **If the relay moves to another domain or
  port, update `connect-src` together with `enidor-config`.**
- **Service worker streams** (`d/--enidor-stream--/<tab session>/<path>`) are answered only by the
  tab whose session ID is in the URL. Range requests support `bytes=a-b`, `bytes=a-` and
  `bytes=-n`; unsatisfiable ranges get a 416.
- **PIN-protected rooms** ask for the PIN in a form (Enter submits, numeric keypad on phones); a
  wrong PIN says so, and a lost connection is reported instead of hanging.

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

While either field is empty, the page doesn't try to connect. It walks the visitor through
opening the room in the app instead (**Join a Guest Room**).

### The relay side

The relay (`enidor_relay`, see its README) serves the directory over HTTPS on `:5443` and
browsers' WebSockets over WSS on `:5003`, both with an automatic `*.libp2p.direct` certificate.
The page only uses unauthenticated, rate-limited endpoints (`GET /link/resolve/{id}`,
`GET /room/{code}`). Everything that changes a room or link is signed by the sharer's libp2p key;
there is no shared secret any more.

*The rest of this section is the original design note, kept for history.*

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

The relay only introduces peers: it carries a browser's WebRTC handshake, or two apps' hole
punching, a few KB each. It caps every relayed connection at 128 KiB and 2 minutes
(`enidor_relay/main.go`), so it can't carry files or messages even for a client that tries, and
the app refuses any such request that arrives over the relay (`handleDirect` in
`internal/core/node.go`). Between two apps, as between an app and a browser, data goes peer to
peer or not at all.

The desktop app needs the WebRTC support in `internal/core/webrtc`, switched on in
`internal/core/node.go`. Older apps without it can't serve the page, since there's no relay
fallback any more; the page shows "Couldn't connect directly" for them.

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
temporarily), serve the site with `python3 -m http.server 8000`, create a share link for the room,
and open `http://localhost:8000/d/?link=<link id>`. A local rig on `http://`/`ws://` URLs also
needs those origins added to `connect-src` in the CSP for the test (and the relay run with
`ENIDOR_DEV=1` for CORS).

The page never downloads over the relay, so every request in the rig's log should show
`via=webrtc`. Useful flags:
- `-webrtc=false` shows the "Couldn't connect directly" message, since there's no fallback.
- `-drop-first 7340032` cuts the first transfer at 7 MB, to exercise resume.
- `-v` logs the WebRTC handshake.

Codes `111111` (closed room) and `222222` (sharer offline) are there to try the error states.
