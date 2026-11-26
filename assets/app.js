(() => {
  'use strict';

  const REPO = 'hermesnetdev/From_project_1_releases';
  const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
  const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  // v2: notes are stored as plain text (v1 cached GitHub's rendered HTML, which is never used now).
  const CACHE_KEY = 'enidor:releases:v3'; // v3: .aab no longer counted as an Android download
  const OLD_CACHE_KEYS = ['enidor:releases:v1', 'enidor:releases:v2'];
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 8000;
  const MAX_NOTES_CHARS = 2000;

  // Every link we render must point at our GitHub account: cached data lives in localStorage,
  // which anything running on this origin could have written.
  const TRUSTED_URL = /^https:\/\/github\.com\/hermesnetdev\//;

  // Checksums, signatures, update metadata, and Android App Bundles (.aab: a Play Store upload
  // format that phones can't install): attached to releases but not something to install.
  const NOT_AN_INSTALLER = /(\.(sha(1|256|512)(sum)?|md5|sig|asc|minisig|pem|blockmap|txt|json|ya?ml|sbom|aab)$)|checksums?|latest(-mac|-linux)?\.yml/i;

  const PLATFORMS = [
    { id: 'android', label: 'Android', test: /\.apk$|android/i },
    { id: 'windows', label: 'Windows', test: /windows|win(32|64)|\.exe$|\.msix?$/i },
    { id: 'mac', label: 'macOS', test: /darwin|mac[-_. ]?os|(^|[^a-z])(mac|osx)([^a-z]|$)|\.dmg$|\.pkg$/i },
    { id: 'linux', label: 'Linux', test: /linux|\.appimage$|\.deb$|\.rpm$/i },
  ];

  const dateFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });

  // ---------- helpers ----------

  // Text and attributes only; there is deliberately no way to set innerHTML.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false || child === '') continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function platformOf(name) {
    if (NOT_AN_INSTALLER.test(name)) return null;
    const match = PLATFORMS.find((p) => p.test.test(name));
    return match ? match.id : 'other';
  }

  function platformLabel(id) {
    const match = PLATFORMS.find((p) => p.id === id);
    return match ? match.label : 'Other';
  }

  function archOf(name) {
    if (/[-_.](all|universal)\b|universal/i.test(name)) return 'universal';
    if (/arm64|aarch64|apple[-_ ]?silicon/i.test(name)) return 'arm';
    if (/amd64|x64|x86_64|win64|intel/i.test(name)) return 'x86';
    return '';
  }

  // "macOS", or "macOS (Apple Silicon)" when a release ships several macOS builds.
  function shortAssetLabel(asset, assets) {
    const label = platformLabel(asset.platform);
    const siblings = assets.filter((a) => a.platform === asset.platform);
    if (siblings.length < 2) return label;
    return `${label} (${archHint(asset.name, asset.platform) || asset.name})`;
  }

  function archHint(name, platform) {
    const arch = archOf(name);
    if (platform === 'mac') {
      if (arch === 'universal') return 'Universal · Apple Silicon & Intel';
      if (arch === 'arm') return 'Apple Silicon';
      if (arch === 'x86') return 'Intel';
    }
    if (platform === 'windows' || platform === 'linux' || platform === 'android') {
      if (arch === 'arm') return 'ARM64';
      if (arch === 'x86') return '64-bit';
    }
    if (platform === 'linux') {
      if (/\.appimage$/i.test(name)) return 'AppImage';
      if (/\.deb$/i.test(name)) return '.deb';
      if (/\.rpm$/i.test(name)) return '.rpm';
    }
    return '';
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }

  function formatDate(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? dateFormat.format(d) : '';
  }

  function detectOS() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/android/i.test(ua) || /android/i.test(platform)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
    if (/mac/i.test(platform) && navigator.maxTouchPoints > 1) return 'ios'; // iPadOS reports as Mac
    if (/mac/i.test(platform) || /mac os x/i.test(ua)) return 'mac';
    if (/win/i.test(platform) || /windows/i.test(ua)) return 'windows';
    if (/linux|cros/i.test(platform) || /linux/i.test(ua)) return 'linux';
    return 'unknown';
  }

  // 'arm' | 'x86' | '' (unknown). Safari never says; Chromium does via client hints.
  async function detectArch() {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
        if (/arm/i.test(architecture || '')) return 'arm';
        if (/x86/i.test(architecture || '')) return 'x86';
      }
    } catch {
      // not allowed or not supported
    }
    if (/aarch64|arm64/i.test(navigator.userAgent || '')) return 'arm';
    return '';
  }

  // The best installer for a platform: for macOS a universal or matching (else Apple Silicon)
  // build, preferring .dmg over .zip; elsewhere the matching architecture, else x86-64.
  function bestAsset(assets, platform, arch) {
    const list = assets.filter((a) => a.platform === platform);
    if (!list.length) return null;
    const score = (a) => {
      const aArch = archOf(a.name);
      let s = 0;
      if (platform === 'mac') {
        if (aArch === 'universal') s += 30;
        else if (arch && aArch === arch) s += 20;
        else if (!arch && aArch === 'arm') s += 15;
        else if (!aArch) s += 10;
        if (/\.dmg$/i.test(a.name)) s += 3;
        else if (/\.pkg$/i.test(a.name)) s += 2;
        else if (/\.zip$/i.test(a.name)) s += 1;
      } else {
        if (arch && aArch === arch) s += 20;
        else if (!aArch || aArch === 'x86') s += 10;
        if (platform === 'windows' && /\.exe$/i.test(a.name)) s += 2;
        if (platform === 'linux' && /\.appimage$/i.test(a.name)) s += 2;
        if (platform === 'linux' && /\.deb$/i.test(a.name)) s += 1;
      }
      return s;
    };
    return list.slice().sort((a, b) => score(b) - score(a))[0];
  }

  // ---------- data ----------

  function notesText(body) {
    const text = String(body || '').replace(/\r\n?/g, '\n').trim();
    return text.length > MAX_NOTES_CHARS ? `${text.slice(0, MAX_NOTES_CHARS).trimEnd()}…` : text;
  }

  function slim(release) {
    return {
      tag: String(release.tag_name || ''),
      name: String(release.name || '').trim() || String(release.tag_name || ''),
      url: release.html_url,
      date: release.published_at || release.created_at,
      prerelease: !!release.prerelease,
      notes: notesText(release.body),
      assets: (release.assets || [])
        .map((a) => ({
          name: String(a.name || ''),
          size: Number(a.size) || 0,
          url: a.browser_download_url,
          platform: platformOf(String(a.name || '')),
        }))
        .filter((a) => a.platform && TRUSTED_URL.test(String(a.url || ''))),
    };
  }

  // Shape and URL checks for anything we're about to render, fresh or cached.
  function isValidRelease(r) {
    return r && typeof r === 'object'
      && typeof r.name === 'string'
      && typeof r.notes === 'string'
      && TRUSTED_URL.test(String(r.url || ''))
      && Array.isArray(r.assets)
      && r.assets.every((a) => a && typeof a.name === 'string'
        && TRUSTED_URL.test(String(a.url || ''))
        && (PLATFORMS.some((p) => p.id === a.platform) || a.platform === 'other'));
  }

  function readCache() {
    try {
      for (const key of OLD_CACHE_KEYS) localStorage.removeItem(key);
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (!cached || !Number.isFinite(cached.time) || !Array.isArray(cached.releases)) return null;
      if (!cached.releases.every(isValidRelease)) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  function writeCache(releases) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), releases }));
    } catch {
      // storage unavailable (private mode, blocked site data): nothing to do
    }
  }

  class RateLimited extends Error {
    constructor(resetAt) {
      super('GitHub API rate limit reached');
      this.resetAt = resetAt; // ms epoch, or 0 if unknown
    }
  }

  async function loadReleases() {
    const cached = readCache();
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) return { releases: cached.releases };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        if (res.status === 429 || remaining === '0') throw new RateLimited(Number.isFinite(reset) ? reset : 0);
      }
      if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('unexpected GitHub API response');
      const releases = data.filter((r) => r && !r.draft).map(slim).filter(isValidRelease);
      writeCache(releases);
      return { releases };
    } catch (err) {
      if (cached) return { releases: cached.releases, stale: true, rateLimited: err instanceof RateLimited };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- rendering ----------

  function renderAsset(asset) {
    const detail = archHint(asset.name, asset.platform);
    return el('li', { class: 'asset' },
      el('div', null,
        el('span', { class: 'asset-os' }, platformLabel(asset.platform)),
        detail && el('span', { class: 'asset-detail' }, ` · ${detail}`),
        el('span', { class: 'asset-file' }, [asset.name, formatSize(asset.size)].filter(Boolean).join(' · ')),
      ),
      el('a', { class: 'btn btn-primary btn-small', href: asset.url }, 'Download'),
    );
  }

  function renderLatest(release, isLatest) {
    return el('article', { class: 'release-latest' },
      el('header', { class: 'release-head' },
        el('div', null,
          el('p', { class: 'release-label' }, isLatest ? 'Latest release' : 'Newest build'),
          el('h3', { class: 'release-title' },
            release.name,
            release.prerelease && el('span', { class: 'badge' }, 'Pre-release'),
          ),
        ),
        el('p', { class: 'release-meta' },
          el('time', { datetime: release.date }, formatDate(release.date)),
          ' · ',
          el('a', { href: release.url }, 'Release page'),
        ),
      ),
      // Plain text: release notes are never parsed as HTML.
      release.notes && el('p', { class: 'release-notes release-notes-text' }, release.notes),
      release.assets.length
        ? el('ul', { class: 'assets' }, release.assets.map(renderAsset))
        : el('p', { class: 'release-notes' }, 'No downloads attached to this release yet.'),
    );
  }

  function renderHistory(releases) {
    return el('div', { class: 'history' },
      el('h3', { class: 'history-title' }, 'Release history'),
      el('ol', { class: 'history-list' },
        releases.map((r) => el('li', { class: 'history-item' },
          el('a', { class: 'history-tag', href: r.url }, r.name),
          el('span', { class: 'history-date' },
            el('time', { datetime: r.date }, formatDate(r.date)),
            r.prerelease && el('span', { class: 'badge' }, 'Pre-release'),
          ),
          el('span', { class: 'history-assets' },
            r.assets.map((a) => el('a', { href: a.url, title: a.name }, shortAssetLabel(a, r.assets))),
          ),
        )),
      ),
    );
  }

  function renderReleases(root, releases, stale, rateLimited) {
    root.replaceChildren();

    if (stale) {
      root.append(el('p', { class: 'status' }, rateLimited
        ? 'GitHub is limiting requests from your network right now, so this is the list from your last visit.'
        : 'GitHub couldn’t be reached just now, so this is the list from your last visit.'));
    }

    if (!releases.length) {
      root.append(el('p', { class: 'status-card' }, 'No releases have been published yet. Check back soon.'));
      return;
    }

    const latest = releases.find((r) => !r.prerelease) || releases[0];
    root.append(renderLatest(latest, !latest.prerelease));

    const rest = releases.filter((r) => r !== latest);
    if (rest.length) root.append(renderHistory(rest));
  }

  function renderError(root, err) {
    let why = 'Couldn’t load the release list from GitHub right now.';
    if (err instanceof RateLimited) {
      const minutes = err.resetAt ? Math.max(1, Math.ceil((err.resetAt - Date.now()) / 60000)) : 0;
      why = minutes
        ? `GitHub is limiting requests from your network; the list will load again in about ${minutes} min.`
        : 'GitHub is limiting requests from your network right now.';
    }
    root.replaceChildren(
      el('p', { class: 'status-card' },
        `${why} Every build is available on the `,
        el('a', { href: RELEASES_PAGE }, 'GitHub releases page'),
        '.',
      ),
    );
  }

  // ---------- hero download buttons ----------

  async function setupHero(latest) {
    const cta = document.getElementById('download');
    const meta = document.getElementById('cta-meta');
    if (!cta) return;

    const os = detectOS();
    const buttons = [...cta.querySelectorAll('[data-platform]')];

    if (latest) {
      const arch = await detectArch();
      for (const b of buttons) {
        const asset = bestAsset(latest.assets, b.dataset.platform, b.dataset.platform === os ? arch : '');
        if (asset) {
          b.href = asset.url;
          b.title = [asset.name, formatSize(asset.size)].filter(Boolean).join(' · ');
          b.hidden = false;
        } else {
          // No build for this platform in the latest release: only the fallback buttons stay.
          b.hidden = b.hasAttribute('data-optional');
        }
      }
    }

    // Put the visitor's platform first and make it the primary button.
    const preferred = buttons.find((b) => b.dataset.platform === os && !b.hidden);
    if (preferred) {
      cta.prepend(preferred);
      for (const b of buttons) {
        b.classList.toggle('btn-primary', b === preferred);
        b.classList.toggle('btn-secondary', b !== preferred);
      }
    }

    if (meta && latest) {
      const version = latest.name.replace(/^v(?=\d)/i, '');
      const platforms = PLATFORMS.map((p) => p.id).filter((id) => latest.assets.some((a) => a.platform === id));
      const list = platforms.map(platformLabel);
      const names = list.length > 1 ? `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}` : list.join('');
      const note = (os === 'ios' || (os === 'android' && !platforms.includes('android')))
        ? ' · Open this page on your computer to install'
        : '';
      meta.textContent = [`Version ${version}`, formatDate(latest.date), names].filter(Boolean).join(' · ') + note;
    }
  }

  // ---------- boot ----------

  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const root = document.getElementById('releases-root');
  setupHero(null);

  loadReleases()
    .then(({ releases, stale, rateLimited }) => {
      if (root) renderReleases(root, releases, stale, rateLimited);
      return setupHero(releases.find((r) => !r.prerelease) || releases[0]);
    })
    .catch((err) => {
      console.warn('Enidor: could not load releases.', err);
      if (root) renderError(root, err);
    });
})();
