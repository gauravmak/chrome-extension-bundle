// ═══════════════════════════════════
//  superlevels: News Feed Eradicator
//  Hides infinite feeds on LinkedIn, X (home), Facebook, Reddit
//  One storage key per site (nfe_linkedin, nfe_x, nfe_facebook, nfe_reddit)
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

  const SITE = hostKey();
  const STORAGE_KEY = SITE ? "nfe_" + SITE : null;

  function inject() {
    if (!SITE) return;
    if (document.getElementById(STYLE_ID)) return;
    const sels = SELECTORS[SITE];
    if (!sels || !sels.length) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = sels.join(",\n") + " { display: none !important; }";
    (document.head || document.documentElement).appendChild(style);
    SL.log.action("nfe", "inject", { site: SITE });
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) { el.remove(); SL.log.action("nfe", "remove", { site: SITE }); }
  }

  if (STORAGE_KEY) {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      SL.log.info("nfe", "init", { site: SITE, enabled: data[STORAGE_KEY] === true });
      if (data[STORAGE_KEY] === true) inject();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "nfe_toggle") return;
    if (msg.site && msg.site !== SITE) return;
    SL.log.info("nfe", "msg.toggle", { site: SITE, enabled: msg.enabled });
    if (msg.enabled) inject();
    else remove();
  });
})();
