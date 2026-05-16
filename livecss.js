// ═══════════════════════════════════
//  superlevels: Live CSS Editor
//  Based on live-css-editor
// ═══════════════════════════════════
(() => {
  const STYLE_ID = "sl-livecss";

  function applyCSS(css) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css || "";
    SL.log.info("livecss", "apply", { host: location.hostname, length: (css || "").length });
  }

  // Load saved CSS for this host on page load
  const host = location.hostname;
  if (host) {
    chrome.storage.local.get(["livecss_" + host], (data) => {
      const css = data["livecss_" + host];
      SL.log.info("livecss", "init", { host, hasCustom: !!css });
      if (css) applyCSS(css);
    });
  }

  // Listen for live updates from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "livecss_update") {
      SL.log.info("livecss", "msg.update", { length: (msg.css || "").length });
      applyCSS(msg.css);
    }
  });
})();
