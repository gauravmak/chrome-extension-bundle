// ═══════════════════════════════════
//  superlevels: LinkedIn Unhook
//  Hides distractions on linkedin.com
// ═══════════════════════════════════
(() => {
  const STYLE_ID = "sl-liunhook";

  const LIUNHOOK_CSS = `
    /* Red "new feed updates" dot on the Home nav icon.
       2026 UI — class names are build hashes, so key off aria-label + shape:
         button[aria-label="Home, 1 new notification"]
           span > svg#home-medium + span   ← the dot (an empty span)
       Classic UI:
         a.global-nav__primary-link[href*="/feed/"]
           div.artdeco-notification-badge > span.notification-badge   ← the dot
       Hide only the dot: in both UIs its wrapper also holds the house icon.
       Badges on the other nav items (Messaging, Notifications) stay visible. */
    button[aria-label^="Home"] svg ~ span,
    .global-nav__primary-link[href*="/feed/"] .notification-badge {
      display: none !important;
    }
  `;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = LIUNHOOK_CSS;
    (document.head || document.documentElement).appendChild(style);
    SL.log.action("liunhook", "inject", { host: location.host });
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) { el.remove(); SL.log.action("liunhook", "remove", { host: location.host }); }
  }

  chrome.storage.local.get(["liunhook_enabled"], (data) => {
    SL.log.info("liunhook", "init", { enabled: data.liunhook_enabled !== false });
    if (data.liunhook_enabled !== false) inject();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "liunhook_toggle") return;
    SL.log.info("liunhook", "msg.toggle", { enabled: msg.enabled });
    if (msg.enabled) inject();
    else remove();
  });
})();
