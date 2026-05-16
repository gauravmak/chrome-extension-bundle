// ═══════════════════════════════════
//  superlevels: News Feed Eradicator
//  Hides infinite feeds on LinkedIn, X (home), Facebook, Reddit
// ═══════════════════════════════════
(() => {
  const STYLE_ID = "sl-nfe";

  function hostKey() {
    const h = location.hostname.replace(/^www\.|^m\.|^mobile\./, "");
    if (h === "linkedin.com" || h.endsWith(".linkedin.com")) return "linkedin";
    if (h === "x.com" || h.endsWith(".x.com")) return "x";
    if (h === "twitter.com" || h.endsWith(".twitter.com")) return "x";
    if (h === "facebook.com" || h.endsWith(".facebook.com")) return "facebook";
    if (h === "reddit.com" || h.endsWith(".reddit.com")) return "reddit";
    return null;
  }

  const SELECTORS = {
    linkedin: [
      "main .scaffold-finite-scroll",
      ".feed-shared-news-module",
      "[data-id='feed-update']",
      "main div[data-finite-scroll-hotkey-context='FEED']",
    ],
    x: [
      "[aria-label='Timeline: Your Home Timeline']",
      "[aria-label^='Timeline: '][aria-label*='Home']",
    ],
    facebook: [
      "[role='feed']",
      "[data-pagelet='Feed']",
      "[data-pagelet^='FeedUnit_']",
    ],
    reddit: [
      "shreddit-feed",
      "main shreddit-async-loader[bundlename='post_listing']",
      "[data-testid='post-container']",
    ],
  };

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const k = hostKey();
    if (!k) return;
    const sels = SELECTORS[k];
    if (!sels || !sels.length) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = sels.join(",\n") + " { display: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  chrome.storage.local.get(["nfe_enabled"], (data) => {
    if (data.nfe_enabled === true) inject();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "nfe_toggle") {
      if (msg.enabled) inject();
      else remove();
    }
  });
})();
