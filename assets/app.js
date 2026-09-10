(() => {
  'use strict';

  const REPO = 'hermesnetdev/From_project_1_releases';
  const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
  const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const CACHE_KEY = 'enidor:releases:v1';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 8000;

  const PLATFORMS = [
    { id: 'mac', label: 'macOS', test: /darwin|macos|osx|\.dmg$|\.pkg$/i },
    { id: 'windows', label: 'Windows', test: /windows|win(32|64)|\.exe$|\.msi$/i },
    { id: 'linux', label: 'Linux', test: /linux|\.appimage$|\.deb$|\.rpm$/i },
  ];

  const dateFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });

  // ---------- helpers ----------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false || child === '') continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function platformOf(name) {
    const match = PLATFORMS.find((p) => p.test.test(name));
    return match ? match.id : 'other';
  }

  function platformLabel(id) {
    const match = PLATFORMS.find((p) => p.id === id);
    return match ? match.label : 'Other';
  }

  // "macOS", or "macOS (Apple Silicon)" when a release ships several macOS builds.
  function shortAssetLabel(asset, assets) {
    const label = platformLabel(asset.platform);
    const siblings = assets.filter((a) => a.platform === asset.platform);
    if (siblings.length < 2) return label;
    return `${label} (${archHint(asset.name, asset.platform) || asset.name})`;
  }

  function archHint(name, platform) {
    if (platform === 'mac') {
      if (/[-_.](all|universal)\b/i.test(name)) return 'Universal · Apple Silicon & Intel';
      if (/arm64|aarch64/i.test(name)) return 'Apple Silicon';
      if (/amd64|x64|x86_64|intel/i.test(name)) return 'Intel';
    }
    if (platform === 'windows' || platform === 'linux') {
      if (/arm64|aarch64/i.test(name)) return 'ARM64';
      if (/amd64|x64|x86_64|win64/i.test(name)) return '64-bit';
    }
    return '';
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }

  function formatDate(iso) {
    return iso ? dateFormat.format(new Date(iso)) : '';
  }

  function detectOS() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/iphone|ipad|ipod|android/i.test(ua)) return 'mobile';
    if (/mac/i.test(platform) && navigator.maxTouchPoints > 1) return 'mobile'; // iPadOS reports as Mac
    if (/mac/i.test(platform) || /mac os x/i.test(ua)) return 'mac';
    if (/win/i.test(platform) || /windows/i.test(ua)) return 'windows';
    if (/linux/i.test(platform)) return 'linux';
    return 'unknown';
  }

  // ---------- data ----------

  function slim(release) {
    return {
      tag: release.tag_name,
      name: (release.name || '').trim() || release.tag_name,
      url: release.html_url,
      date: release.published_at || release.created_at,
      prerelease: !!release.prerelease,
      notesHtml: (release.body_html || '').trim(),
      assets: (release.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        url: a.browser_download_url,
        platform: platformOf(a.name),
      })),
    };
  }

  function readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      return cached && Array.isArray(cached.releases) ? cached : null;
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

  async function loadReleases() {
    const cached = readCache();
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) return { releases: cached.releases };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: 'application/vnd.github.html+json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
      const releases = (await res.json()).filter((r) => !r.draft).map(slim);
      writeCache(releases);
      return { releases };
    } catch (err) {
      if (cached) return { releases: cached.releases, stale: true };
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
      release.notesHtml && el('div', { class: 'release-notes', html: release.notesHtml }),
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

  function renderReleases(root, releases, stale) {
    root.replaceChildren();

    if (stale) {
      root.append(el('p', { class: 'status' }, 'GitHub couldn’t be reached just now, so this is the list from your last visit.'));
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

  function renderError(root) {
    root.replaceChildren(
      el('p', { class: 'status-card' },
        'Couldn’t load the release list from GitHub right now. Every build is available on the ',
        el('a', { href: RELEASES_PAGE }, 'GitHub releases page'),
        '.',
      ),
    );
  }

  // ---------- hero download buttons ----------

  function setupHero(latest) {
    const cta = document.getElementById('download');
    const meta = document.getElementById('cta-meta');
    if (!cta) return;

    const os = detectOS();
    const buttons = [...cta.querySelectorAll('[data-platform]')];

    // Put the visitor's platform first and make it the primary button.
    const preferred = buttons.find((b) => b.dataset.platform === os);
    if (preferred) {
      cta.prepend(preferred);
      for (const b of buttons) {
        b.classList.toggle('btn-primary', b === preferred);
        b.classList.toggle('btn-secondary', b !== preferred);
      }
    }

    if (!latest) return;

    for (const b of buttons) {
      const asset = latest.assets.find((a) => a.platform === b.dataset.platform);
      if (asset) {
        b.href = asset.url;
        b.title = `${asset.name} · ${formatSize(asset.size)}`;
      }
    }

    if (meta) {
      const version = latest.name.replace(/^v(?=\d)/i, '');
      const note = os === 'mobile' ? ' · Open this page on your Mac or PC to install' : '';
      meta.textContent = `Version ${version} · ${formatDate(latest.date)} · macOS & Windows${note}`;
    }
  }

  // ---------- boot ----------

  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const root = document.getElementById('releases-root');
  setupHero(null);

  loadReleases()
    .then(({ releases, stale }) => {
      if (root) renderReleases(root, releases, stale);
      setupHero(releases.find((r) => !r.prerelease) || releases[0]);
    })
    .catch((err) => {
      console.warn('Enidor: could not load releases.', err);
      if (root) renderError(root);
    });
})();
