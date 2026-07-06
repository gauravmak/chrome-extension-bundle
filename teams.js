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
            // Teams' MSAL wrapper schema is {data, id, lastUpdatedAt, nonce}.
            // The wrapper itself is encrypted (data field), but lastUpdatedAt
            // is plaintext unix-ms — when the token was last refreshed. A max
            // across all entries gives us a "tokens haven't been touched for N
            // minutes" signal even though we can't read expiresOn directly.
            if (parsed.lastUpdatedAt) {
              info.lastUpdatedAt = parsed.lastUpdatedAt;
              const lutMs = Number(parsed.lastUpdatedAt);
              if (Number.isFinite(lutMs) && lutMs > 1e12) {
                info.lastUpdatedAtAgeMin = Math.round((Date.now() - lutMs) / 60000);
              }
            }
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
      // Summary line: count by credentialType, min/max secondsTillExpiry, plus
      // min/max age of lastUpdatedAt — the staleness signal we'll evaluate.
      const byType = {};
      let minTtl = Infinity, maxTtl = -Infinity, withTtl = 0;
      let minLutAge = Infinity, maxLutAge = -Infinity, withLut = 0;
      for (const e of entries) {
        if (e.credentialType) byType[e.credentialType] = (byType[e.credentialType] || 0) + 1;
        if (typeof e.secondsTillExpiry === "number") {
          withTtl++;
          if (e.secondsTillExpiry < minTtl) minTtl = e.secondsTillExpiry;
          if (e.secondsTillExpiry > maxTtl) maxTtl = e.secondsTillExpiry;
        }
        if (typeof e.lastUpdatedAtAgeMin === "number") {
          withLut++;
          if (e.lastUpdatedAtAgeMin < minLutAge) minLutAge = e.lastUpdatedAtAgeMin;
          if (e.lastUpdatedAtAgeMin > maxLutAge) maxLutAge = e.lastUpdatedAtAgeMin;
        }
      }
      const summary = { found: entries.length, withTtl, withLut, byType };
      if (withTtl > 0) { summary.minTtl = minTtl; summary.maxTtl = maxTtl; }
      if (withLut > 0) { summary.minLutAgeMin = minLutAge; summary.maxLutAgeMin = maxLutAge; }
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
    // "We need you to sign in again. This could be a request from your IT
    // department…" is the actual Teams session-expiry banner — it shows up in
    // every expiry episode in the logs. Match the "sign in again" phrasing
    // specifically: a bare /sign in/ also matches every "Sign in" button on the
    // page (and our own prompt) and buries the real signal in noise.
    { name: "signin-again",  re: /(?:we need you to )?sign in again/i },
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

  // Our own re-auth overlay (#sl-teams-auth-prompt) literally contains the
  // words "Teams session expired" and "sign in again". Scanning the raw
  // document.body.innerText matched OUR text and logged a phantom banner the
  // instant we showed the prompt (see logs: two signin.text.detected events
  // fire immediately after auth.prompt.shown). Strip our overlay's own text
  // before scanning — innerText serializes a subtree contiguously, so one
  // indexOf/splice removes exactly its contribution and nothing else.
  function bodyTextWithoutOwnUI() {
    let text = document.body.innerText || "";
    const own = document.getElementById("sl-teams-auth-prompt");
    if (own) {
      const ownText = own.innerText || "";
      const i = ownText ? text.indexOf(ownText) : -1;
      if (i !== -1) text = text.slice(0, i) + " " + text.slice(i + ownText.length);
    }
    return text;
  }

  function scanBannerText(reason) {
    if (!document.body) return;
    try {
      const fullText = bodyTextWithoutOwnUI().slice(0, SCAN_TEXT_CAP);
      const now = Date.now();
      for (const p of BANNER_PATTERNS) {
        const m = fullText.match(p.re);
        if (!m) continue;
        const last = lastSeenForPattern.get(p.name) || 0;
        if (now - last < 30_000) continue;  // rate-limit per pattern
        lastSeenForPattern.set(p.name, now);
        const idx = m.index || 0;
        const sample = fullText.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, " ").trim();
        // info-level on purpose: the banner persists and re-logs every 30s
        // per pattern. warn would flood chrome://extensions Errors panel.
        report("info", "signin.text.detected", {
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

  // ═══════════════════════════════════
  //  Early re-auth prompt
  //
  //  No more active probing from the content script — fetches from here
  //  go out with cookies but NO Authorization header (MSAL keeps the
  //  access token encrypted in localStorage, see msal.scan logs), so any
  //  probe to a Teams API endpoint always returns 401 regardless of
  //  session state. We therefore rely purely on the background's signal:
  //  when Teams' OWN API calls (which DO carry the Bearer token) return
  //  a burst of 401s, that's the real "session is dead" event.
  //
  //  On Yes, we navigate directly to AAD's authorize endpoint — skipping
  //  Teams' 37-144s lazy detection.
  //
  //  Tenant/client IDs are hardcoded from this user's captured nav-to-
  //  login URLs — personal extension, single tenant. If you ever change
  //  tenants, capture a fresh nav.to.login URL and update these.
  // ═══════════════════════════════════
  const TEAMS_TENANT_ID = "9652d7c2-1ccf-4940-8151-4a92bd474ed0";
  const TEAMS_CLIENT_ID = "5e3ce6c0-2b1f-4285-8d4b-75ee78787346";

  function isAuthBusy() {
    const h = location.href;
    return /\/authv2(\?|#|$)/.test(h) || /[?#&]code=/.test(h);
  }

  function buildAuthorizeUrl() {
    const u = new URL("https://login.microsoftonline.com/" + TEAMS_TENANT_ID + "/oauth2/v2.0/authorize");
    const p = u.searchParams;
    p.set("client_id", TEAMS_CLIENT_ID);
    p.set("response_type", "code");
    p.set("redirect_uri", "https://teams.microsoft.com/v2/");
    p.set("scope", "openid profile offline_access");
    p.set("prompt", "select_account");
    p.set("state", "sl-teams-" + Date.now());
    p.set("nonce", "sl-teams-" + Date.now());
    return u.toString();
  }

  let promptDismissedAt = 0;            // throttle re-prompt after No

  function showAuthPrompt(reason) {
    if (document.getElementById("sl-teams-auth-prompt")) return;
    if (isAuthBusy()) return;
    if (Date.now() - promptDismissedAt < 5 * 60 * 1000) return;  // user said No recently
    // info: a notable event but not an error — keep it out of chrome://extensions Errors panel.
    report("info", "auth.prompt.shown", { reason, at: t() });

    const overlay = document.createElement("div");
    overlay.id = "sl-teams-auth-prompt";
    overlay.style.cssText = [
      "position:fixed", "top:20px", "right:20px", "z-index:2147483647",
      "background:#fff", "color:#222",
      "border:1px solid #5b5fc7", "border-radius:6px",
      "padding:14px 18px", "max-width:340px",
      "box-shadow:0 6px 18px rgba(0,0,0,0.18)",
      "font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "Teams session expired";
    title.style.cssText = "font-weight:600;margin-bottom:6px;color:#5b5fc7";
    overlay.appendChild(title);

    const msg = document.createElement("div");
    msg.textContent = "SuperLevels detected your Teams session is no longer valid. Sign in again now?";
    msg.style.cssText = "margin-bottom:12px";
    overlay.appendChild(msg);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

    const btnBase = "padding:6px 14px;border-radius:4px;cursor:pointer;font:inherit";

    const no = document.createElement("button");
    no.textContent = "No";
    no.style.cssText = btnBase + ";background:transparent;color:#444;border:1px solid #ccc";
    no.addEventListener("click", () => {
      report("info", "auth.prompt.no", { at: t() });
      promptDismissedAt = Date.now();
      overlay.remove();
    });

    const yes = document.createElement("button");
    yes.textContent = "Yes, sign in";
    yes.style.cssText = btnBase + ";background:#5b5fc7;color:#fff;border:none";
    yes.addEventListener("click", () => {
      report("info", "auth.prompt.yes", { at: t() });
      const url = buildAuthorizeUrl();
      overlay.remove();
      window.location.href = url;
    });

    row.appendChild(no);
    row.appendChild(yes);
    overlay.appendChild(row);
    document.body.appendChild(overlay);
  }

  // Background pings us when it sees a burst of 401s from Teams' own
  // requests — that's our only trigger for the dialog. Pass the burst
  // count along for the log so we can audit false positives.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "teamsSessionLikelyDead") {
      showAuthPrompt("bg-401-burst:" + (msg.count || "?"));
    }
  });
})();
