// ═══════════════════════════════════
//  superlevels: shared logger + notifier
//  Loaded by popup, background (importScripts), and every content script.
//  Exposes a single global `SL` with:
//    SL.log.debug(module, action, data?)
//    SL.log.info(module, action, data?)
//    SL.log.warn(module, action, data?)
//    SL.log.error(module, action, data?)
//    SL.log.action(module, action, data?)   ← high-signal "user did X"
//    SL.notify(message, kind?, opts?)       ← popup-only toast
// ═══════════════════════════════════
(function (root) {
  if (root.SL && root.SL._loaded) return;

  function ts() {
    const d = new Date();
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" + String(d.getMinutes()).padStart(2, "0") +
      ":" + String(d.getSeconds()).padStart(2, "0") +
      "." + String(d.getMilliseconds()).padStart(3, "0")
    );
  }

  function emit(level, module, action, data) {
    const time = ts();
    const head = "[SL]";
    const mod = "[" + (module || "?") + "]";
    const msg = action || "";
    const fn = console[level] || console.log;
    if (data === undefined) {
      fn.call(console, head, time, mod, msg);
    } else {
      fn.call(console, head, time, mod, msg, data);
    }
  }

  const log = {
    debug:  (m, a, d) => emit("debug", m, a, d),
    info:   (m, a, d) => emit("info",  m, a, d),
    warn:   (m, a, d) => emit("warn",  m, a, d),
    error:  (m, a, d) => emit("error", m, a, d),
    // High-signal user-initiated action. Same channel as info, but visually distinct.
    action: (m, a, d) => emit("info",  m, "▶ " + a, d),
  };

  // ── Toast notifier — popup context only. Safe no-op if no document.body. ──
  function notify(message, kind, opts) {
    log.action("notify", message, kind ? { kind } : undefined);
    if (typeof document === "undefined" || !document.body) return;
    // Skip when running inside a content script's host page — we don't want to
    // splatter toasts onto arbitrary websites. Detect popup context by checking
    // for the chrome-extension:// URL.
    try {
      if (!/^chrome-extension:\/\//.test(location.href)) return;
    } catch (_) { return; }

    let toast = document.getElementById("sl-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "sl-toast";
      toast.className = "sl-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = "sl-toast show" + (kind ? " " + kind : "");
    clearTimeout(toast._slT);
    const duration = (opts && opts.duration) || 2500;
    toast._slT = setTimeout(() => {
      toast.className = "sl-toast";
    }, duration);
  }

  root.SL = { log, notify, _loaded: true };
})(typeof self !== "undefined" ? self : globalThis);
