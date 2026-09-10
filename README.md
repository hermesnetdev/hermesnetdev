# hermesnetdev

Website for **Enidor**, served with GitHub Pages from the `main` branch.

It's a plain static site with no build step:

- `index.html`: the page
- `assets/style.css`: styles (light and dark themes follow the OS setting)
- `assets/app.js`: loads releases live from [hermesnetdev/From_project_1_releases](https://github.com/hermesnetdev/From_project_1_releases/releases)
- `.nojekyll`: tells GitHub Pages to serve the files as-is

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
