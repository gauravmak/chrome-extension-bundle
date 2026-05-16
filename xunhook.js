// ═══════════════════════════════════
//  superlevels: X Unhook
//  Hides distractions on x.com / twitter.com
// ═══════════════════════════════════
(() => {
  const STYLE_ID = "sl-xunhook";

  const XUNHOOK_CSS = `
    /* Right sidebar — keep the search bar at top, hide all panels below
       (Live on X, Today's News, What's happening, Who to follow, Premium upsell, etc.).
       The first child of SidebarContents is the search; everything after is a panel. */
    div[data-testid="sidebarColumn"] > div > div > div > div > div > div:not(:first-of-type) {
      display: none !important;
    }
    /* Explore link in left nav */
    header[role="banner"] nav a[href="/explore"] {
      display: none !important;
    }
    /* Explore link inside the More overflow dialog */
    div[aria-labelledby="modal-header"] a[href="/explore"] {
      display: none !important;
    }
  `;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = XUNHOOK_CSS;
    (document.head || document.documentElement).appendChild(style);
    SL.log.action("xunhook", "inject", { host: location.host });
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) { el.remove(); SL.log.action("xunhook", "remove", { host: location.host }); }
  }

  chrome.storage.local.get(["xunhook_enabled"], (data) => {
    SL.log.info("xunhook", "init", { enabled: data.xunhook_enabled !== false });
    if (data.xunhook_enabled !== false) inject();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "xunhook_toggle") {
      SL.log.info("xunhook", "msg.toggle", { enabled: msg.enabled });
      if (msg.enabled) inject();
      else remove();
    }
  });
})();
