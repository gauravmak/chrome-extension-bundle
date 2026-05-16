// ═══════════════════════════════════
//  superlevels: YouTube Unhook
//  Based on remove-youtube-suggestions
// ═══════════════════════════════════
(() => {
  const STYLE_ID = "sl-unhook";

  const UNHOOK_CSS = `
    /* Homepage: hide feed entirely */
    ytd-browse[page-subtype="home"] #contents.ytd-rich-grid-renderer,
    ytd-browse[page-subtype="home"] ytd-rich-grid-renderer,
    ytd-browse[page-subtype="home"] #primary > ytd-rich-grid-renderer,
    ytd-browse[page-subtype="home"] ytd-rich-section-list-renderer,
    ytd-browse[page-subtype="home"] #header,
    ytd-browse[page-subtype="home"] .ytd-browse-chips-wrapper {
      display: none !important;
    }
    /* Black homepage background with message */
    ytd-browse[page-subtype="home"] #primary {
      display: flex !important;
      justify-content: center;
      align-items: center;
      min-height: 60vh;
    }
    ytd-browse[page-subtype="home"] #primary::before {
      content: 'Focus Mode — Use the search bar';
      font-size: 20px;
      color: #444;
      font-family: 'YouTube Sans', 'Roboto', sans-serif;
      font-weight: 500;
    }
    /* Sidebar suggestions on video pages */
    #secondary.ytd-watch-flexy,
    ytd-watch-next-secondary-results-renderer,
    #related {
      display: none !important;
    }
    /* Make video player wider without sidebar */
    ytd-watch-flexy[flexy][is-two-columns_] #primary.ytd-watch-flexy {
      max-width: 100% !important;
    }
    /* End screen suggestions & cards */
    .ytp-ce-element,
    .ytp-endscreen-content,
    .ytp-suggestion-set,
    .ytp-cards-teaser,
    .ytp-ce-covering-overlay,
    .ytp-ce-element-show {
      display: none !important;
    }
    /* Trending / Explore feed */
    ytd-browse[page-subtype="trending"] #contents {
      display: none !important;
    }
    /* Homepage chips / categories bar */
    #chips-wrapper.ytd-feed-filter-chip-bar-renderer,
    ytd-feed-filter-chip-bar-renderer {
      display: none !important;
    }
    /* Shorts shelf */
    ytd-rich-shelf-renderer[is-shorts],
    ytd-reel-shelf-renderer {
      display: none !important;
    }
    /* "For You" / recommendation shelves */
    ytd-rich-shelf-renderer {
      display: none !important;
    }
  `;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = UNHOOK_CSS;
    (document.head || document.documentElement).appendChild(style);
    SL.log.action("unhook", "inject", { host: location.host });
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) { el.remove(); SL.log.action("unhook", "remove", { host: location.host }); }
  }

  chrome.storage.local.get(["unhook_enabled"], (data) => {
    SL.log.info("unhook", "init", { enabled: data.unhook_enabled !== false });
    if (data.unhook_enabled !== false) inject();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "unhook_toggle") {
      SL.log.info("unhook", "msg.toggle", { enabled: msg.enabled });
      if (msg.enabled) inject();
      else remove();
    }
  });
})();
