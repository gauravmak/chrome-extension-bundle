// ═══════════════════════════════════
//  superlevels: News Feed Eradicator
//  Hides infinite feeds on LinkedIn, X (home), Facebook, Instagram, Reddit
//  One storage key per site (nfe_linkedin, nfe_x, nfe_facebook, nfe_instagram, nfe_reddit)
// ═══════════════════════════════════
(() => {
  const STYLE_ID = "sl-nfe";

  function hostKey() {
    const h = location.hostname.replace(/^www\.|^m\.|^mobile\./, "");
    if (h === "linkedin.com" || h.endsWith(".linkedin.com")) return "linkedin";
    if (h === "x.com" || h.endsWith(".x.com")) return "x";
    if (h === "twitter.com" || h.endsWith(".twitter.com")) return "x";
    if (h === "facebook.com" || h.endsWith(".facebook.com")) return "facebook";
    if (h === "instagram.com" || h.endsWith(".instagram.com")) return "instagram";
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
      "[data-pagelet='MainFeed']",
      "[data-pagelet='Feed']",
      "[data-pagelet^='FeedUnit_']",
    ],
    instagram: [
      "main article",
    ],
    reddit: [
      "shreddit-feed",
      "main shreddit-async-loader[bundlename='post_listing']",
      "[data-testid='post-container']",
    ],
  };

  // Sites that render the feed's element type elsewhere too (Instagram reuses
  // <article> for single posts and post modals). For these we only hide the
  // feed on the home route, gated behind a documentElement attribute that an
  // SPA-route watcher keeps in sync — an unscoped rule would blank out
  // intentionally-opened posts.
  const HOME_ONLY = {
    instagram: (p) => p === "/",
  };
  const HOME_ATTR = "data-sl-nfe-home";

  const SITE = hostKey();
  const STORAGE_KEY = SITE ? "nfe_" + SITE : null;

  function styleText() {
    const sels = SELECTORS[SITE];
    if (!sels || !sels.length) return "";
    const list = HOME_ONLY[SITE] ? sels.map((s) => `html[${HOME_ATTR}] ${s}`) : sels;
    return list.join(",\n") + " { display: none !important; }";
  }

  let homeTimer = null;
  function updateHomeFlag() {
    const test = HOME_ONLY[SITE];
    const el = document.documentElement;
    if (test && test(location.pathname)) el.setAttribute(HOME_ATTR, "");
    else el.removeAttribute(HOME_ATTR);
  }
  // Instagram is a SPA: pushState navigations fire no event, and the page's
  // history calls live in a world we can't patch from a content script, so we
  // poll the path. A cheap string compare, and only while the toggle is on.
  function startHomeWatch() {
    if (!HOME_ONLY[SITE] || homeTimer !== null) return;
    updateHomeFlag();
    homeTimer = setInterval(updateHomeFlag, 1000);
  }
  function stopHomeWatch() {
    if (homeTimer !== null) { clearInterval(homeTimer); homeTimer = null; }
    document.documentElement.removeAttribute(HOME_ATTR);
  }

  function inject() {
    if (!SITE) return;
    if (document.getElementById(STYLE_ID)) return;
    const css = styleText();
    if (!css) return;
    if (HOME_ONLY[SITE]) startHomeWatch();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    SL.log.action("nfe", "inject", { site: SITE });
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) { el.remove(); SL.log.action("nfe", "remove", { site: SITE }); }
    if (HOME_ONLY[SITE]) stopHomeWatch();
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
