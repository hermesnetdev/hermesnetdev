// Google AdSense ad placements. A page shows ads only if its <head> has Google's AdSense tag
// (adsbygoogle.js?client=ca-pub-…); this file fills that page's [data-ad] placements with ad
// units. The receive page (d/) never gets the tag or this file: ad code there could read share
// links, PINs and the files themselves.
(() => {
  'use strict';

  // Display ad units from AdSense → Ads → By ad unit, keyed by each placement's data-ad name.
  // A placement without its own unit uses `default`. With no unit at all, placements stay
  // hidden; Auto ads (switched on in AdSense) still work from the tag alone.
  const SLOTS = {
    default: '',
  };

  // The publisher ID comes from the page's AdSense tag, so it's written in one place per page.
  const tag = document.querySelector('script[src*="/adsbygoogle.js?client="]');
  const client = tag && new URL(tag.src).searchParams.get('client');
  if (!client || !/^ca-pub-\d{16}$/.test(client)) return;

  // Local previews request test ads, so they don't count as real impressions.
  const testing = location.hostname !== 'enidor.com';

  window.adsbygoogle = window.adsbygoogle || [];
  for (const box of document.querySelectorAll('[data-ad]')) {
    const slot = SLOTS[box.dataset.ad] || SLOTS.default;
    if (!slot) continue;
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.dataset.adClient = client;
    ins.dataset.adSlot = slot;
    ins.dataset.adFormat = 'auto';
    ins.dataset.fullWidthResponsive = 'true';
    if (testing) ins.dataset.adtest = 'on';
    box.append(ins);
    box.hidden = false;
    window.adsbygoogle.push({});
  }
})();
