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
