// Google AdSense. Nothing loads from Google until CLIENT is set, so the site stays ad-free
// until the account is approved. The receive page (d/) never loads this file: ad code there
// could read share links, PINs and the files themselves.
(() => {
  'use strict';

  // AdSense → Account → Account information → Publisher ID, written "ca-pub-" + 16 digits.
  // The same digits go in /ads.txt.
  const CLIENT = '';

  // Display ad units from AdSense → Ads → By ad unit, keyed by each placement's data-ad name.
  // A placement without its own unit uses `default`. With no unit at all, placements stay
  // hidden; Auto ads (switched on in AdSense) still work from CLIENT alone.
  const SLOTS = {
    default: '',
  };

  if (!/^ca-pub-\d{16}$/.test(CLIENT)) return;

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT}`;
  document.head.append(script);

  // Local previews request test ads, so they don't count as real impressions.
  const testing = location.hostname !== 'enidor.com';

  window.adsbygoogle = window.adsbygoogle || [];
  for (const box of document.querySelectorAll('[data-ad]')) {
    const slot = SLOTS[box.dataset.ad] || SLOTS.default;
    if (!slot) continue;
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.dataset.adClient = CLIENT;
    ins.dataset.adSlot = slot;
    ins.dataset.adFormat = 'auto';
    ins.dataset.fullWidthResponsive = 'true';
    if (testing) ins.dataset.adtest = 'on';
    box.append(ins);
    box.hidden = false;
    window.adsbygoogle.push({});
  }
})();
