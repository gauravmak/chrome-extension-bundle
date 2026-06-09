// ═══════════════════════════════════
//  Teams session observer — content script (observation only, no actions).
//
//  Goal: figure out which signal (if any) reliably fires BEFORE Teams' own
//  "Your session has expired, sign in" banner becomes visible, so we can
//  later decide whether the extension can proactively trigger SSO refresh.
//
//  All values read from the page (DOM text, localStorage entries, URLs) are
//  treated as untrusted and only fed to console.log — never to innerHTML,
//  eval, chrome.tabs.create, or any other sink that would interpret them.
//  Token *values* are never logged; only key names, byte sizes, schema
//  keys, and any field that looks like an expiry timestamp.
// ═══════════════════════════════════
(function () {
  if (!/^https?:\/\/(teams\.microsoft\.com|.*\.teams\.microsoft\.com|teams\.live\.com|.*\.teams\.cloud\.microsoft)\//i.test(location.href)) return;

  const T0 = performance.now();
  const t = () => Math.round(performance.now() - T0);

  // report(): log to console AND ship to background's persistent ring buffer
  // so events survive DevTools being closed. Failure to send (SW asleep,
  // extension context invalidated during reload) is silently ignored.
  function report(level, action, data) {
    SL.log[level]("teams", action, data);
    try {
      const p = chrome.runtime.sendMessage({
        type: "teamsLog",
        entry: { ts: Date.now(), level, action, data: data || null },
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) { /* extension context invalidated */ }
  }

  report("info", "load", { url: location.href.slice(0, 200), title: document.title.slice(0, 100), at: t() });

  // ── 1. MSAL token introspection ─────────────────────────────────────
  // Teams stores tokens under msal.* keys. v1 used flat schemas; v2/v3
  // wrap values in nested JSON. Field names we've seen: expiresOn,
  // expiresOnTimestamp, expires_on, exp, extendedExpiresOn, extExpiresOn,
  // cachedAt. We try all of them, fall back to any /expires/i field, and
  // ALSO dump the raw schema keys of the first parsed entry per scan as
  // a diagnostic so we can confirm the format.
  function timestampToSeconds(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 1e8) return null;
    return n > 1e12 ? Math.floor(n / 1000) : n;  // ms → s
  }
  function findExpiryFields(obj) {
    const out = {};
    const candidates = ["expiresOn", "expiresOnTimestamp", "expires_on", "expires", "exp",
                        "extendedExpiresOn", "extExpiresOn", "extendedExpiresOnTimestamp"];
    for (const c of candidates) {
      if (obj[c] !== undefined && obj[c] !== null && obj[c] !== "") out[c] = obj[c];
    }
    for (const k of Object.keys(obj)) {
      if (/expir/i.test(k) && !(k in out)) out[k] = obj[k];
    }
    return out;
  }

  function scanMsalTokens(reason) {
    try {
      const ls = window.localStorage;
      const entries = [];
      const now = Math.floor(Date.now() / 1000);
      let diagDumped = false;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k) continue;
        if (!/msal|teams-cdl|skype|access[_-]?token|refresh[_-]?token|tmp\.auth/i.test(k)) continue;
        const v = ls.getItem(k);
        const bytes = v ? v.length : 0;
        const info = { key: k, bytes };
        if (v && bytes < 50000) {
          let parsed = undefined;
          try { parsed = JSON.parse(v); } catch (_) { info.parseError = true; }
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // One-time per-scan diagnostic: dump schema (key + value type)
            // of the first parsed object. We never log raw values.
            if (!diagDumped) {
              const schema = {};
              for (const sk of Object.keys(parsed).slice(0, 25)) {
                const tv = parsed[sk];
                schema[sk] = tv === null ? "null"
                  : Array.isArray(tv) ? "array"
                  : typeof tv === "object" ? "object"
                  : typeof tv === "string" ? "string(" + tv.length + ")"
                  : typeof tv;
              }
              info.schema = schema;
              diagDumped = true;
            }
            if (parsed.credentialType) info.credentialType = parsed.credentialType;
            if (parsed.cachedAt)       info.cachedAt = parsed.cachedAt;
            const exp = findExpiryFields(parsed);
            if (Object.keys(exp).length) {
              info.expiry = exp;
              // Convert primary expiry to seconds-till for quick reading.
              const primary = exp.expiresOn || exp.expiresOnTimestamp || exp.expires_on || exp.expires || exp.exp;
              const asSec = primary != null ? timestampToSeconds(primary) : null;
              if (asSec !== null) info.secondsTillExpiry = asSec - now;
            }
          } else if (parsed !== undefined) {
            info.parseType = parsed === null ? "null" : (Array.isArray(parsed) ? "array" : typeof parsed);
          }
        }
        entries.push(info);
      }
      // Summary line: count by credentialType + min/max secondsTillExpiry.
      const byType = {};
      let minTtl = Infinity, maxTtl = -Infinity, withTtl = 0;
      for (const e of entries) {
        if (e.credentialType) byType[e.credentialType] = (byType[e.credentialType] || 0) + 1;
        if (typeof e.secondsTillExpiry === "number") {
          withTtl++;
          if (e.secondsTillExpiry < minTtl) minTtl = e.secondsTillExpiry;
          if (e.secondsTillExpiry > maxTtl) maxTtl = e.secondsTillExpiry;
        }
      }
      const summary = { found: entries.length, withTtl, byType };
      if (withTtl > 0) { summary.minTtl = minTtl; summary.maxTtl = maxTtl; }
      report("info", "msal.scan", { reason, at: t(), ...summary, entries: entries.slice(0, 30) });
    } catch (err) {
      report("warn", "msal.scan.fail", { error: err.message });
    }
  }

  // ── 2. Sign-in / disconnection banner detector (broad) ──────────────
  // Previous version restricted to role-elements + narrow regex and
  // missed at least one real occurrence. Now we scan the entire body
  // innerText for any of a wider keyword set, rate-limited so a single
  // persistent banner doesn't spam, but state changes still surface.
  const BANNER_PATTERNS = [
    { name: "sign-in",       re: /sign in/i },
    { name: "signed-out",    re: /signed out|you'?ve been signed out/i },
    { name: "session-expired", re: /session.{0,30}(expired|ended|timed? out)/i },
    { name: "reconnect",     re: /reconnect|trying to connect|connection lost/i },
    { name: "cant-reach",    re: /can'?t reach|couldn'?t (?:reach|connect)|unable to connect/i },
    { name: "something-wrong", re: /something went wrong|we're having trouble/i },
    { name: "youre-offline", re: /you'?re offline|you appear to be offline/i },
    { name: "reauthenticate", re: /re-?authenticat/i },
    { name: "your-sign-in",  re: /your sign-?in.{0,40}(expired|timed? out|ended)/i },
  ];
  const SCAN_TEXT_CAP = 60000;
  const lastSeenForPattern = new Map();  // pattern.name → ts of last log

  function scanBannerText(reason) {
    if (!document.body) return;
    try {
      const fullText = (document.body.innerText || "").slice(0, SCAN_TEXT_CAP);
      const now = Date.now();
      for (const p of BANNER_PATTERNS) {
        const m = fullText.match(p.re);
        if (!m) continue;
        const last = lastSeenForPattern.get(p.name) || 0;
        if (now - last < 30_000) continue;  // rate-limit per pattern
        lastSeenForPattern.set(p.name, now);
        const idx = m.index || 0;
        const sample = fullText.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, " ").trim();
        report("warn", "signin.text.detected", {
          at: t(), reason, pattern: p.name, idx, sample,
          title: document.title.slice(0, 100),
          visibility: document.visibilityState,
          online: navigator.onLine,
        });
      }
    } catch (err) {
      report("warn", "banner.scan.fail", { error: err.message });
    }
  }

  // ── 3. Title change detector ────────────────────────────────────────
  // Teams updates document.title to indicate state (e.g. unread counts,
  // "Connecting...", "Microsoft Teams"). State transitions may precede
  // the banner appearing.
  let lastTitle = document.title;
  setInterval(() => {
    if (document.title !== lastTitle) {
      report("info", "title.change", {
        from: lastTitle.slice(0, 100), to: document.title.slice(0, 100), at: t(),
      });
      lastTitle = document.title;
    }
  }, 1000);

  // ── 4. Focus tracking ───────────────────────────────────────────────
  window.addEventListener("focus", () => report("info", "window.focus", { at: t() }));
  window.addEventListener("blur",  () => report("info", "window.blur",  { at: t() }));

  // ── 5. Wire up observers ────────────────────────────────────────────
  function startObservers() {
    scanMsalTokens("startup");
    scanBannerText("startup");

    let pending = false;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; scanBannerText("mutation"); });
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Periodic re-scan of tokens + banner text.
    setInterval(() => scanMsalTokens("interval"), 60_000);
    setInterval(() => scanBannerText("interval"), 5_000);

    document.addEventListener("visibilitychange", () => {
      report("info", "visibility", { state: document.visibilityState, at: t(), title: document.title.slice(0, 100) });
      if (document.visibilityState === "visible") {
        scanMsalTokens("visible");
        scanBannerText("visible");
      }
    });
  }

  if (document.body) {
    startObservers();
  } else {
    document.addEventListener("DOMContentLoaded", startObservers, { once: true });
  }

  // ── 6. Connectivity + URL change ────────────────────────────────────
  window.addEventListener("online",  () => report("info", "net.online",  { at: t() }));
  window.addEventListener("offline", () => report("warn", "net.offline", { at: t() }));

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      report("info", "url.change", { from: lastUrl.slice(0, 200), to: location.href.slice(0, 200), at: t() });
      lastUrl = location.href;
    }
  }, 1000);
})();
