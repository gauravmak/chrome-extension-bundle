importScripts("logger.js");
SL.log.info("bg", "boot");

// ═══════════════════════════════════
//  Persistent state across SW restarts
//
//  MV3 service workers terminate after ~30s of idle. Module-scope variables
//  reset on wake, so we mirror them to `chrome.storage.session` (memory-backed,
//  dies on browser close — exactly the lifetime we want). Every mutation
//  write-throughs to session storage; SW boot reloads everything before any
//  state-reading code path runs.
// ═══════════════════════════════════
const KEY_REDIRECT_DATA = "sl_redirectData";

let redirectData = {};     // { tabId: { chain, finalUrl, finalStatus } }

// Boot loader — every code path that touches state must await this once.
const stateReady = (async () => {
  try {
    const data = await chrome.storage.session.get([KEY_REDIRECT_DATA]);
    redirectData = data[KEY_REDIRECT_DATA] || {};
    SL.log.info("bg", "state.restored", { redirects: Object.keys(redirectData).length });
  } catch (err) {
    SL.log.warn("bg", "state.restore.fail", { error: err.message });
  }
})();

function persistRedirectData() {
  chrome.storage.session.set({ [KEY_REDIRECT_DATA]: redirectData }).catch((err) => {
    SL.log.warn("bg", "state.persist.redirectData.fail", { error: err.message });
  });
}

// On tab removed, clean up redirect data for that tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId in redirectData) {
    delete redirectData[tabId];
    persistRedirectData();
  }
});

// ═══════════════════════════════════
//  Redirect Tracer
// ═══════════════════════════════════

// When a new main-frame navigation starts, reset the chain
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  redirectData[details.tabId] = { chain: [], finalUrl: null, finalStatus: null };
  persistRedirectData();
});

// Capture each redirect hop
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type !== "main_frame") return;
    if (!redirectData[details.tabId]) {
      redirectData[details.tabId] = { chain: [], finalUrl: null, finalStatus: null };
    }
    redirectData[details.tabId].chain.push({
      url: details.url,
      statusCode: details.statusCode,
      statusLine: details.statusLine || "",
      redirectUrl: details.redirectUrl,
    });
    persistRedirectData();
  },
  { urls: ["<all_urls>"] }
);

// Capture final completed request
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.type !== "main_frame") return;
    if (!redirectData[details.tabId]) {
      redirectData[details.tabId] = { chain: [], finalUrl: null, finalStatus: null };
    }
    redirectData[details.tabId].finalUrl = details.url;
    redirectData[details.tabId].finalStatus = details.statusCode;
    persistRedirectData();
  },
  { urls: ["<all_urls>"] }
);

// ═══════════════════════════════════
//  Teams session observer (background side)
//
//  Observation only: log non-2xx responses against MS Teams + login hosts
//  so we can see whether the extension can detect session expiry earlier
//  than Teams' own user-visible "sign in again" banner. Token values are
//  never read or logged here — only status codes, methods, and URL.
//
//  Events are also appended to a ring buffer in chrome.storage.local
//  (KEY_TEAMS_LOG, capped at TEAMS_LOG_CAP) so the user can come back
//  later — long after DevTools was closed — and dump the history.
// ═══════════════════════════════════
const TEAMS_HOSTS = [
  "*://teams.microsoft.com/*",
  "*://*.teams.microsoft.com/*",
  "*://*.teams.cloud.microsoft/*",
  "*://teams.live.com/*",
  "*://*.skype.com/*",
  "*://login.microsoftonline.com/*",
  "*://login.microsoft.com/*",
  "*://login.live.com/*",
];

const KEY_TEAMS_LOG = "teams_log_ring";
// 1000, up from 500: msal.scan entries now ship summary-only except at
// diagnostic moments (see teams.js), so each entry is far lighter and the ring
// holds several expiry episodes before wrapping. Entries are small JSON — 1000
// stays well under the chrome.storage.local quota.
const TEAMS_LOG_CAP = 1000;
let teamsLog = [];
let teamsLogPersistTimer = null;

const teamsLogReady = (async () => {
  try {
    const data = await chrome.storage.local.get([KEY_TEAMS_LOG]);
    teamsLog = Array.isArray(data[KEY_TEAMS_LOG]) ? data[KEY_TEAMS_LOG] : [];
    SL.log.info("bg", "teams.log.restored", { entries: teamsLog.length });
  } catch (err) {
    SL.log.warn("bg", "teams.log.restore.fail", { error: err.message });
  }
})();

function persistTeamsLog() {
  if (teamsLogPersistTimer) return;
  teamsLogPersistTimer = setTimeout(() => {
    teamsLogPersistTimer = null;
    chrome.storage.local.set({ [KEY_TEAMS_LOG]: teamsLog }).catch((err) => {
      SL.log.warn("bg", "teams.log.persist.fail", { error: err.message });
    });
  }, 250);
}

function appendTeamsLog(entry) {
  teamsLog.push(entry);
  if (teamsLog.length > TEAMS_LOG_CAP) {
    teamsLog.splice(0, teamsLog.length - TEAMS_LOG_CAP);
  }
  persistTeamsLog();
}

function bgTeamsReport(level, action, data) {
  SL.log[level]("bg", action, data);
  teamsLogReady.then(() => {
    appendTeamsLog({ ts: Date.now(), level, src: "bg", action, data: data || null });
  });
}

// Sliding-window 401 burst detector per tab. A single 401 from a Teams
// API endpoint is NOT enough to trigger our dialog: even logged-in
// sessions hit occasional 401s on stale signed-URL thumbnails and similar.
// But session expiry produces a *burst* — Teams retries multiple endpoints
// and they all fail in rapid succession. We require >= TEAMS_401_BURST
// failures inside TEAMS_401_BURST_WINDOW_MS to fire.
//
// A 401 only signals a dead session when it's a CORE, token-gated API call.
// Media / link-preview / real-time-signaling endpoints 401 on stale signed
// URLs with a perfectly valid session: the logs show asyncgw urlp/objects
// (link-preview thumbnails, chat media) 401ing in bursts while signed in, and
// still 401ing AFTER a successful re-login. Those media 401s were the sole
// trigger of the only false "session dead" prompt we ever fired — never count
// them. The host filter alone is not enough: asyncgw.teams.microsoft.com
// matches /teams\.microsoft\.com/.
const TEAMS_401_NONSESSION_RE = /\.asyncgw\.|\/urlp\/|\/objects\/|\.trouter\./i;
// 2 was too trigger-happy — two coincidental 401s in 30s fired the prompt.
const TEAMS_401_BURST = 3;
const TEAMS_401_BURST_WINDOW_MS = 30_000;
const TEAMS_401_FIRE_COOLDOWN_MS = 60_000;
const teams401Timestamps = new Map();  // tabId → number[] (ms epoch)
const teams401LastFiredAt = new Map(); // tabId → ms epoch

// Stable family tag for a Teams request URL so the exported log can be
// aggregated by endpoint (jq group_by) across expiry episodes instead of
// re-deriving families from raw URLs each time. Most-specific first. "media"/
// "trouter" are the known signed-URL / signaling noise (TEAMS_401_NONSESSION_RE);
// everything else is a token-gated call whose 401/403 may mean a dead session.
function teamsEndpointFamily(url) {
  const u = url || "";
  if (TEAMS_401_NONSESSION_RE.test(u)) return /\.trouter\./i.test(u) ? "trouter" : "media";
  if (/\/api\/authsvc\//i.test(u))     return "authsvc";
  if (/\/api\/chatsvc\//i.test(u))     return "chatsvc";
  if (/\/api\/mt\//i.test(u))          return "mt";
  if (/\/api\/mcps\//i.test(u))        return "mcps";
  if (/\/ups\//i.test(u))              return "ups";
  if (/\bflightproxy\./i.test(u))      return "flightproxy";
  if (/^https?:\/\/login\./i.test(u))  return "login";
  return "other";
}

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.statusCode < 400) return;
    // For 401s, decide up front whether this is a session-gated call so the
    // log records WHY a 401 did or didn't count toward a burst — that makes a
    // later "check the log file" pass self-explanatory instead of guesswork.
    const is401 = d.statusCode === 401;
    const sessionRelevant = is401
      && /teams\.microsoft\.com|teams\.cloud\.microsoft/.test(d.url)
      && !TEAMS_401_NONSESSION_RE.test(d.url);
    // authDenied: the candidate expiry marker we're now collecting evidence for.
    // The one real expiry episode in the logs was a 403 on authsvc + 404s on
    // chatsvc — NOT a 401 burst — so the 401-only sessionRelevant signal below
    // never fired for it. Flag 401 AND 403 on any core (non media/trouter)
    // endpoint so a future export can test which status+family actually precedes
    // the banner. Observation only: this does NOT feed the burst detector yet.
    const endpoint = teamsEndpointFamily(d.url);
    const authDenied = (d.statusCode === 401 || d.statusCode === 403)
      && endpoint !== "media" && endpoint !== "trouter";
    bgTeamsReport("info", "teams.http.fail", {
      status: d.statusCode,
      method: d.method,
      type: d.type,
      url: d.url.slice(0, 220),
      tabId: d.tabId,
      endpoint,
      ...(authDenied ? { authDenied: true } : {}),
      ...(is401 ? { sessionRelevant } : {}),
    });
    if (!is401) return;
    if (d.tabId < 0) return;
    if (!sessionRelevant) return;

    const now = Date.now();
    const arr = teams401Timestamps.get(d.tabId) || [];
    const fresh = arr.filter((ts) => now - ts < TEAMS_401_BURST_WINDOW_MS);
    fresh.push(now);
    teams401Timestamps.set(d.tabId, fresh);

    if (fresh.length < TEAMS_401_BURST) return;
    const lastFired = teams401LastFiredAt.get(d.tabId) || 0;
    if (now - lastFired < TEAMS_401_FIRE_COOLDOWN_MS) return;
    teams401LastFiredAt.set(d.tabId, now);

    bgTeamsReport("info", "teams.401.burst", { tabId: d.tabId, count: fresh.length, windowMs: TEAMS_401_BURST_WINDOW_MS });
    chrome.tabs.sendMessage(d.tabId, { type: "teamsSessionLikelyDead", count: fresh.length }).catch(() => { /* no listener */ });
  },
  { urls: TEAMS_HOSTS }
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    bgTeamsReport("info", "teams.http.err", {
      error: d.error,
      method: d.method,
      type: d.type,
      url: d.url.slice(0, 220),
      tabId: d.tabId,
      endpoint: teamsEndpointFamily(d.url),
    });
  },
  { urls: TEAMS_HOSTS }
);

// Main-frame navigation tracking — the smoking-gun signal for a session
// expiry that triggers a redirect. We log every transition into a login
// host and every return into teams.microsoft.com from a login host.
const LOGIN_HOST_RE = /^https?:\/\/(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|login\.windows\.net)\//i;
const TEAMS_HOST_RE = /^https?:\/\/(teams\.microsoft\.com|.*\.teams\.microsoft\.com|teams\.live\.com|.*\.teams\.cloud\.microsoft)\//i;
const lastMainFrameUrlByTab = new Map();

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  const url = d.url || "";
  if (LOGIN_HOST_RE.test(url)) {
    const prev = lastMainFrameUrlByTab.get(d.tabId) || null;
    bgTeamsReport("info", "teams.nav.to.login", {
      tabId: d.tabId, url: url.slice(0, 220),
      fromUrl: prev ? prev.slice(0, 220) : null,
    });
  } else if (TEAMS_HOST_RE.test(url)) {
    const prev = lastMainFrameUrlByTab.get(d.tabId) || "";
    if (LOGIN_HOST_RE.test(prev)) {
      bgTeamsReport("info", "teams.nav.from.login", {
        tabId: d.tabId, url: url.slice(0, 220), fromUrl: prev.slice(0, 220),
      });
    }
  }
  // Track last main-frame URL only when it's a Teams or login host so we
  // don't bloat the map with every browsed-to page.
  if (LOGIN_HOST_RE.test(url) || TEAMS_HOST_RE.test(url)) {
    lastMainFrameUrlByTab.set(d.tabId, url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastMainFrameUrlByTab.delete(tabId);
  teams401Timestamps.delete(tabId);
  teams401LastFiredAt.delete(tabId);
});

// Respond to popup requests
// Validate a teamsLog message before trusting it. Content scripts on
// teams.microsoft.com are the only intended sender, but onMessage receives
// from anywhere holding the extension ID — treat the payload as untrusted.
function isValidTeamsLogEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return false;
  if (typeof e.level !== "string" || !/^(debug|info|warn|error)$/.test(e.level)) return false;
  if (typeof e.action !== "string" || e.action.length === 0 || e.action.length > 120) return false;
  if (e.data !== null && e.data !== undefined && typeof e.data !== "object") return false;
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "teamsLog") {
    if (isValidTeamsLogEntry(msg.entry)) {
      teamsLogReady.then(() => {
        appendTeamsLog({
          ts: msg.entry.ts,
          level: msg.entry.level,
          src: "teams",
          action: msg.entry.action,
          data: msg.entry.data || null,
        });
      });
    }
    return;
  }
  if (msg && msg.type === "exportTeamsLog") {
    teamsLogReady.then(() => {
      sendResponse({ entries: teamsLog.slice(), cap: TEAMS_LOG_CAP });
    });
    return true;
  }
  if (msg && msg.type === "clearTeamsLog") {
    teamsLog = [];
    chrome.storage.local.set({ [KEY_TEAMS_LOG]: teamsLog }).then(() => {
      SL.log.info("bg", "teams.log.cleared");
      sendResponse({ ok: true });
    }).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  SL.log.info("bg", "msg.received", { type: msg && msg.type, from: sender && sender.id });
  if (msg.type === "getRedirects") {
    // Ensure session-restored state is loaded before answering — otherwise a
    // popup opened right after SW wake gets empty results.
    stateReady.then(() => {
      const data = redirectData[msg.tabId] || { chain: [], finalUrl: null, finalStatus: null };
      SL.log.info("bg", "msg.getRedirects", { tabId: msg.tabId, hops: data.chain.length });
      sendResponse(data);
    });
    return true; // async sendResponse
  }
  if (msg.type === "pip") {
    SL.log.action("bg", "pip", { tabId: msg.tabId });
    chrome.scripting.executeScript({
      target: { tabId: msg.tabId },
      func: () => {
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture();
          return { action: "exited" };
        }
        const videos = Array.from(document.querySelectorAll("video"));
        if (!videos.length) return { error: "No video found on this page" };
        const playing = videos.filter(v => !v.paused && !v.ended);
        let video;
        if (playing.length) {
          video = playing.reduce((a, b) =>
            (b.videoWidth * b.videoHeight) > (a.videoWidth * a.videoHeight) ? b : a
          );
        } else {
          video = videos.reduce((a, b) =>
            (b.videoWidth * b.videoHeight) > (a.videoWidth * a.videoHeight) ? b : a
          );
        }
        return video.requestPictureInPicture()
          .then(() => ({ action: "entered" }))
          .catch(e => ({ error: e.message }));
      },
    }).then(results => {
      sendResponse(results[0]?.result || { error: "No result" });
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // async sendResponse
  }
});

// ═══════════════════════════════════
//  Focus → Bounce to Reading Material
//
//  When enabled in the popup's Focus tab, navigating to a known time-sink
//  page is redirected to the LATEST bookmark in the "Reading Material" folder:
//    • YouTube home                    (youtube.com/)
//    • LinkedIn home / feed            (linkedin.com/ , /feed)
//    • the user's own LinkedIn profile (/in/<slug>, slug configured in popup)
//    • Facebook home / feed            (facebook.com/ , /home.php)
//    • Instagram home / feed           (instagram.com/)
//
//  Lives in the background so it fires with the popup closed. Bookmark URLs
//  are page-originated and therefore UNTRUSTED — we only ever navigate to an
//  http(s) target (CLAUDE.md: scheme-allowlist any URL before navigating).
// ═══════════════════════════════════
const READING_FOLDER_NAME = "Reading Material";
// Bounce is configured per social platform — one toggle each. (The old global
// `focus_redirect_enabled` key is migrated into these on upgrade; see the
// onInstalled hook below.)
const FOCUS_REDIRECT_KEYS = {
  youtube: "focus_redirect_youtube",
  linkedin: "focus_redirect_linkedin",
  facebook: "focus_redirect_facebook",
  instagram: "focus_redirect_instagram",
};
const KEY_FOCUS_REDIRECT_LI = "focus_redirect_li_profile";

const focusRedirectPlatforms = { youtube: false, linkedin: false, facebook: false, instagram: false };
let focusRedirectLiSlug = "";
let focusRedirectLiRe = null;
const pendingRedirectToast = new Map(); // tabId → toast message awaiting page load

// Map a focusRedirectReason() label ("youtube-home", "linkedin-profile", …) to
// its platform key, so we can consult that platform's toggle. Returns null for
// anything not backed by a known toggle.
function platformForReason(reason) {
  if (!reason) return null;
  const platform = String(reason).split("-")[0];
  return platform in focusRedirectPlatforms ? platform : null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Accept a full profile URL ("https://www.linkedin.com/in/jane-doe/") or a
// bare slug ("jane-doe") and reduce it to the /in/<slug> identifier.
function liSlugFromValue(v) {
  if (!v) return "";
  const s = String(v).trim();
  const m = s.match(/\/in\/([^/?#]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return s.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
}

function setFocusRedirectLi(v) {
  focusRedirectLiSlug = liSlugFromValue(v);
  focusRedirectLiRe = focusRedirectLiSlug
    ? new RegExp("^/in/" + escapeRegExp(focusRedirectLiSlug) + "(?:/|$)")
    : null;
}

function safeUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function isHttpUrl(raw) {
  const u = safeUrl(raw);
  return !!u && (u.protocol === "http:" || u.protocol === "https:");
}

// Returns a short reason label if the URL is a redirect-worthy time-sink,
// else null.
function focusRedirectReason(rawUrl) {
  const u = safeUrl(rawUrl);
  if (!u) return null;
  const host = u.hostname;
  const path = u.pathname || "/";
  if (/(^|\.)youtube\.com$/.test(host)) {
    return path === "/" ? "youtube-home" : null;
  }
  if (/(^|\.)linkedin\.com$/.test(host)) {
    if (path === "/" || path === "/feed" || path === "/feed/") return "linkedin-home";
    if (focusRedirectLiRe && focusRedirectLiRe.test(path)) return "linkedin-profile";
  }
  if (/(^|\.)facebook\.com$/.test(host)) {
    if (path === "/" || path === "/home.php" || path === "/home.php/") return "facebook-home";
  }
  if (/(^|\.)instagram\.com$/.test(host)) {
    if (path === "/") return "instagram-home";
  }
  return null;
}

// Find-only walk of the bookmark tree (mirrors popup.js). Prefers a folder
// under the bookmarks bar (id "1"); returns the folder id or null.
async function findReadingFolderId() {
  if (!chrome.bookmarks) return null;
  const tree = await chrome.bookmarks.getTree();
  let preferred = null, fallback = null;
  function walk(node, underBar) {
    if (!node) return;
    if (!node.url && node.title === READING_FOLDER_NAME) {
      if (underBar && !preferred) preferred = node;
      else if (!fallback) fallback = node;
    }
    for (const child of node.children || []) walk(child, underBar || node.id === "1");
  }
  for (const root of tree) walk(root, false);
  return (preferred || fallback || {}).id || null;
}

async function getLatestReadingUrl() {
  const folderId = await findReadingFolderId();
  if (!folderId) return null;
  const kids = await chrome.bookmarks.getChildren(folderId);
  const links = (kids || []).filter((k) => k.url && isHttpUrl(k.url));
  if (!links.length) return null;
  links.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
  return links[0].url;
}

function redirectToastMessage(reason) {
  const labels = {
    "youtube-home": "YouTube home",
    "linkedin-home": "the LinkedIn feed",
    "linkedin-profile": "your LinkedIn profile",
    "facebook-home": "the Facebook feed",
    "instagram-home": "the Instagram feed",
  };
  return "🧰 Chrome Toolbelt: bounced from " + (labels[reason] || "a distraction") + " to your latest Reading Material bookmark";
}

// Injected into the destination page (isolated world) to show a self-dismissing
// toast, so it's clear the extension — not the site — performed the redirect.
function showRedirectToast(message) {
  try {
    const ID = "sl-redirect-toast";
    const prev = document.getElementById(ID);
    if (prev) prev.remove();
    const el = document.createElement("div");
    el.id = ID;
    el.textContent = message;
    el.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:340px;" +
      "background:#16213e;color:#e0e0e0;border:1px solid #e94560;border-radius:8px;" +
      "padding:12px 16px;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "box-shadow:0 4px 20px rgba(0,0,0,0.45);opacity:0;transition:opacity .25s;";
    (document.body || document.documentElement).appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "1"; });
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 400);
    }, 4500);
  } catch (e) { /* best-effort — never break the destination page */ }
}

async function maybeRedirectTab(tabId, rawUrl) {
  await focusRedirectReady;
  const reason = focusRedirectReason(rawUrl);
  if (!reason) return;
  const platform = platformForReason(reason);
  if (!platform || !focusRedirectPlatforms[platform]) return; // this platform's bounce is off
  let target;
  try {
    target = await getLatestReadingUrl();
  } catch (err) {
    SL.log.warn("bg", "focusRedirect.lookup.fail", { error: err.message });
    return;
  }
  if (!target) {
    SL.log.info("bg", "focusRedirect.noTarget", { reason });
    return; // empty / missing folder → let the navigation proceed
  }
  if (!isHttpUrl(target)) {
    SL.log.warn("bg", "focusRedirect.targetRejected", { target: String(target).slice(0, 80) });
    return;
  }
  // Loop guard: never bounce to a page that is itself a time-sink, and never
  // re-navigate a tab to the URL it is already on.
  if (focusRedirectReason(target) || target === rawUrl) return;
  SL.log.action("bg", "focusRedirect", { reason, to: target.slice(0, 120) });
  try {
    await chrome.tabs.update(tabId, { url: target });
    // Queue an in-page toast to fire once the destination finishes loading.
    pendingRedirectToast.set(tabId, redirectToastMessage(reason));
  } catch (err) {
    SL.log.warn("bg", "focusRedirect.update.fail", { tabId, error: err.message });
  }
}

async function sweepOpenTabsForRedirect() {
  try {
    const tabs = await chrome.tabs.query({ url: ["*://*.youtube.com/*", "*://*.linkedin.com/*", "*://*.facebook.com/*", "*://*.instagram.com/*"] });
    for (const t of tabs) {
      if (t.id != null && t.url) maybeRedirectTab(t.id, t.url);
    }
  } catch (err) {
    SL.log.warn("bg", "focusRedirect.sweep.fail", { error: err.message });
  }
}

const focusRedirectReady = (async () => {
  try {
    const d = await chrome.storage.local.get([...Object.values(FOCUS_REDIRECT_KEYS), KEY_FOCUS_REDIRECT_LI]);
    for (const [platform, key] of Object.entries(FOCUS_REDIRECT_KEYS)) {
      focusRedirectPlatforms[platform] = d[key] === true;
    }
    setFocusRedirectLi(d[KEY_FOCUS_REDIRECT_LI]);
    SL.log.info("bg", "focusRedirect.restored", { platforms: { ...focusRedirectPlatforms }, hasLiProfile: !!focusRedirectLiSlug });
  } catch (err) {
    SL.log.warn("bg", "focusRedirect.restore.fail", { error: err.message });
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (KEY_FOCUS_REDIRECT_LI in changes) {
    setFocusRedirectLi(changes[KEY_FOCUS_REDIRECT_LI].newValue);
    SL.log.info("bg", "focusRedirect.liProfile.updated", { hasLiProfile: !!focusRedirectLiSlug });
  }
  let turnedOn = false;
  for (const [platform, key] of Object.entries(FOCUS_REDIRECT_KEYS)) {
    if (!(key in changes)) continue;
    focusRedirectPlatforms[platform] = changes[key].newValue === true;
    SL.log.info("bg", "focusRedirect.platformChanged", { platform, enabled: focusRedirectPlatforms[platform] });
    if (focusRedirectPlatforms[platform]) turnedOn = true;
  }
  if (turnedOn) sweepOpenTabsForRedirect(); // bounce already-open time-sink tabs
});

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  maybeRedirectTab(d.tabId, d.url);
});

// When a bounced tab finishes loading, show the in-page toast exactly once.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const msg = pendingRedirectToast.get(tabId);
  if (!msg) return;
  pendingRedirectToast.delete(tabId);
  chrome.scripting.executeScript({
    target: { tabId },
    func: showRedirectToast,
    args: [msg],
  }).catch((err) => SL.log.warn("bg", "focusRedirect.toast.fail", { error: err && err.message }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingRedirectToast.delete(tabId);
});

// ═══════════════════════════════════
//  WhatsApp send queue (wasend)
//
//  Manually triggered from the popup's Quick tab: a small queue of
//  `phone | message` lines is sent one at a time through the user's own
//  WhatsApp Web session, in ONE visible foreground tab the user watches.
//
//  v2 — the app is loaded ONCE per run and chats are switched inside it:
//
//    1. Adopt a web.whatsapp.com tab the user already has open (or the one
//       from earlier in this run) and reuse it with NO reload when the content
//       script answers a ping. Otherwise load the plain app URL into it once —
//       a run does one app load, or zero if the app was already up.
//    2. Per item, the PRIMARY path is `wasend.sendInApp`: the content script
//       searches the chat list for the phone number, opens the one matching
//       chat and types the text. No reload, no navigation.
//    3. If that attempt says fallback:true (ambiguous search, no search box,
//       content script unreachable …) the item — and only that item — is
//       retried through the v1 deep-link flow, which carries the phone number
//       in the URL. The next item goes back to trying in-app first.
//
//  Each item records mode "in-app" or "url" in the status and the logs. A
//  fallback success is a success; an item counts as failed only when both
//  paths fail.
//
//  Deliberate guardrails — this is a convenience feature, not a blaster:
//    • hard cap of WASEND_MAX_ITEMS per run, one run at a time
//    • every field re-validated here even though the popup validated it
//      (message payloads are untrusted — CLAUDE.md)
//    • the URL is assembled ONLY from validated parts, never from a string
//      handed over by the sender
//    • randomized 3–8s human-paced gap between items
//    • the content script refuses to click unless the composer text matches
//      the validated text exactly (see wasend.js safety gate), and refuses to
//      open a chat unless the search matched EXACTLY ONE row (ambiguity rule)
//    • never fall back after a send was attempted — a deep-link retry on top
//      of an unconfirmed click could double-send
//    • Stop button, and closing the tab aborts the run
//
//  Run state is mirrored to chrome.storage.local[WASEND_STATUS_KEY] so the
//  popup can render progress without holding a port open. It is ALWAYS
//  finalized — no exit path leaves state "running". If the MV3 service
//  worker is killed mid-run the run dies with it; the boot fixup below
//  reconciles the orphaned "running" status on the next wake.
// ═══════════════════════════════════
const WASEND_STATUS_KEY = "wasend_status";
const WASEND_MAX_ITEMS = 20;
const WASEND_MIN_GAP_MS = 3000;
const WASEND_MAX_GAP_MS = 8000;
const WASEND_ITEM_DEADLINE_MS = 60000; // one delivery attempt's round trip
const WASEND_CS_RETRY_MS = 10000;      // content script may not be injected yet
const WASEND_LOAD_DEADLINE_MS = 30000; // tab reaching status "complete"
const WASEND_SETTLE_MS = 1200;         // let WhatsApp hydrate after "complete"
const WASEND_APP_URL = "https://web.whatsapp.com/";
const WASEND_PING_MS = 3000;           // liveness probe budget, per ping
const WASEND_APP_READY_MS = 45000;     // hydration wait after a fresh load

// ── Persisted diagnostics ring (mirrors the Teams observer's ring) ──
// The service-worker console is the durable place for these events, but only
// if someone remembered to open it BEFORE the run. This ring keeps the same
// events in chrome.storage.local so a failed run can be exported from the
// popup afterwards. Privacy is identical to the console: structural data
// only — counts, selector variants, lengths, hashes, reasons. Never message
// text, never chat titles.
const KEY_WASEND_LOG = "wasend_log_ring";
const WASEND_LOG_CAP = 400;
let wasendLogRing = [];
let wasendLogPersistTimer = null;

const wasendLogReady = (async () => {
  try {
    const data = await chrome.storage.local.get([KEY_WASEND_LOG]);
    wasendLogRing = Array.isArray(data[KEY_WASEND_LOG]) ? data[KEY_WASEND_LOG] : [];
    SL.log.info("bg", "wasend.log.restored", { entries: wasendLogRing.length });
  } catch (err) {
    SL.log.warn("bg", "wasend.log.restore.fail", { error: err && err.message });
  }
})();

function persistWasendLog() {
  if (wasendLogPersistTimer) return;
  wasendLogPersistTimer = setTimeout(() => {
    wasendLogPersistTimer = null;
    chrome.storage.local.set({ [KEY_WASEND_LOG]: wasendLogRing }).catch((err) => {
      SL.log.warn("bg", "wasend.log.persist.fail", { error: err && err.message });
    });
  }, 250);
}

function appendWasendLog(entry) {
  wasendLogRing.push(entry);
  if (wasendLogRing.length > WASEND_LOG_CAP) {
    wasendLogRing.splice(0, wasendLogRing.length - WASEND_LOG_CAP);
  }
  persistWasendLog();
}

// The one logging call the wasend section uses: console AND ring, always both.
function wasendLog(level, action, data) {
  const fn = SL.log[level] || SL.log.info;
  fn("bg", action, data);
  wasendLogReady.then(() => {
    appendWasendLog({ ts: Date.now(), level, action, data: data || null });
  });
}

let wasendRun = null; // { tabId, items, index, sent, failed, lastMode, stopping, stopReason }

function wasendSleepRaw(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// Interruptible sleep — returns false as soon as the run is asked to stop.
async function wasendSleep(ms) {
  const until = Date.now() + Math.max(0, ms);
  while (Date.now() < until) {
    if (!wasendRun || wasendRun.stopping) return false;
    await wasendSleepRaw(Math.min(250, until - Date.now()));
  }
  return !!wasendRun && !wasendRun.stopping;
}

function wasendNonce() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function wasendWriteStatus(status) {
  chrome.storage.local.set({ [WASEND_STATUS_KEY]: status }).catch((err) => {
    wasendLog("warn", "wasend.status.persist.fail", { error: err && err.message });
  });
}

function wasendSnapshot(state, extra) {
  const r = wasendRun;
  const base = {
    state,
    total: r ? r.items.length : 0,
    sent: r ? r.sent : 0,
    failed: r ? r.failed : 0,
    current: r ? r.index : 0,
    lastError: "",
    mode: r ? (r.lastMode || "") : "", // "in-app" | "url" — how the last item went
    ts: Date.now(),
  };
  return Object.assign(base, extra || {});
}

function wasendPublish(state, extra) {
  wasendWriteStatus(wasendSnapshot(state, extra));
}

// ── Validation — the popup validates too; this is the authoritative pass. ──
function wasendCleanPhone(raw) {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[\s\-()+]/g, "");
  return /^[0-9]{8,15}$/.test(digits) ? digits : null;
}

function wasendCleanText(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 1 || t.length > 4096) return null;
  return t;
}

// Returns { items } or { error }.
function wasendValidateQueue(queue) {
  if (!Array.isArray(queue)) return { error: "queue must be an array" };
  if (queue.length < 1) return { error: "queue is empty" };
  if (queue.length > WASEND_MAX_ITEMS) return { error: "queue exceeds the cap of " + WASEND_MAX_ITEMS };
  const items = [];
  for (let i = 0; i < queue.length; i++) {
    const raw = queue[i];
    if (!raw || typeof raw !== "object") return { error: "item " + (i + 1) + ": not an object" };
    const phone = wasendCleanPhone(raw.phone);
    if (!phone) return { error: "item " + (i + 1) + ": phone must be 8–15 digits" };
    const text = wasendCleanText(raw.text);
    if (!text) return { error: "item " + (i + 1) + ": message must be 1–4096 chars" };
    items.push({ phone, text });
  }
  return { items };
}

// URL built ONLY from the validated digits + the validated text.
function wasendUrlFor(item) {
  return "https://web.whatsapp.com/send?phone=" + item.phone + "&text=" + encodeURIComponent(item.text);
}

// ── Waiting for the dedicated tab to finish loading ──
const wasendCompleteWaiters = new Map(); // tabId → resolve fn

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const resolve = wasendCompleteWaiters.get(tabId);
  if (!resolve) return;
  wasendCompleteWaiters.delete(tabId);
  resolve(true);
});

// Resolves true when the tab reports "complete", false on stop/deadline/gone.
// The listener above is the primary signal; the poll is a safety net for a
// "complete" that fired in the gap before we registered, and only trusts a
// status read once the navigation has certainly started.
async function wasendWaitForLoad(tabId) {
  const deadline = Date.now() + WASEND_LOAD_DEADLINE_MS;
  let settled = false;
  const viaEvent = new Promise((resolve) => {
    wasendCompleteWaiters.set(tabId, (v) => { settled = true; resolve(v); });
  });
  const viaPoll = (async () => {
    const pollFrom = Date.now() + 3000;
    while (!settled && Date.now() < deadline) {
      await wasendSleepRaw(500);
      if (settled) return false;
      if (!wasendRun || wasendRun.stopping) return false;
      if (Date.now() < pollFrom) continue;
      let tab = null;
      try { tab = await chrome.tabs.get(tabId); } catch (_) { return false; }
      if (!tab) return false;
      if (tab.status === "complete" && typeof tab.url === "string" &&
          tab.url.indexOf("https://web.whatsapp.com/") === 0) {
        settled = true;
        return true;
      }
    }
    return false;
  })();
  const result = await Promise.race([viaEvent, viaPoll]);
  wasendCompleteWaiters.delete(tabId);
  return result === true;
}

// ── One content-script round trip ──
// Retries only the "cannot reach the content script" case (it may not be
// injected yet); a real reply — including a refusal — is final.
//
// `fallback` in the result means "nothing was sent and nothing was clicked, so
// this item may safely be retried through the deep link". Only the content
// script's own verdict and a never-reached content script qualify: a timeout
// or a garbled reply is deliberately NOT a fallback, because the send may have
// gone through without us hearing about it.
async function wasendRoundTrip(tabId, payload, deadlineAt) {
  const nonce = wasendNonce();
  const retryUntil = Date.now() + WASEND_CS_RETRY_MS;
  while (true) {
    if (!wasendRun || wasendRun.stopping) return { ok: false, reason: "stopped" };
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return { ok: false, reason: "timeout" };
    try {
      const raced = await Promise.race([
        chrome.tabs.sendMessage(tabId, Object.assign({ nonce }, payload)),
        wasendSleepRaw(remaining).then(() => ({ __timeout: true })),
      ]);
      if (raced && raced.__timeout) return { ok: false, reason: "timeout" };
      if (!raced || typeof raced !== "object") return { ok: false, reason: "bad-reply" };
      if (raced.nonce !== nonce) return { ok: false, reason: "nonce-mismatch" };
      if (raced.ok === true) {
        return { ok: true, reason: "", diag: typeof raced.diag === "string" ? raced.diag.slice(0, 200) : "" };
      }
      return {
        ok: false,
        reason: String(raced.reason || "unknown").slice(0, 60),
        fallback: raced.fallback === true,
        // Structural crumb trail from the content script — see wasend.js.
        diag: typeof raced.diag === "string" ? raced.diag.slice(0, 200) : "",
      };
    } catch (err) {
      // No receiving end yet → the content script is still loading.
      if (Date.now() < retryUntil && Date.now() < deadlineAt) {
        wasendLog("debug", "wasend.cs.retry", { error: (err && err.message) || "unreachable" });
        if (!(await wasendSleep(1000))) return { ok: false, reason: "stopped" };
        continue;
      }
      return { ok: false, reason: "no-content-script", fallback: true };
    }
  }
}

// v1 path: the chat and the text came from the deep link already in the tab.
function wasendDeliver(tabId, item, deadlineAt) {
  return wasendRoundTrip(tabId, { type: "wasend.send", expectText: item.text }, deadlineAt);
}

// v2 path: the app is loaded; the content script switches chats in-app.
function wasendDeliverInApp(tabId, item, deadlineAt) {
  return wasendRoundTrip(
    tabId,
    { type: "wasend.sendInApp", phone: item.phone, expectText: item.text },
    deadlineAt,
  );
}

// Read-only liveness probe. { ok:true, state, detail } or { ok:false, reason }.
async function wasendPingTab(tabId) {
  const nonce = wasendNonce();
  try {
    const raced = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "wasend.ping", nonce }),
      wasendSleepRaw(WASEND_PING_MS).then(() => ({ __timeout: true })),
    ]);
    if (!raced || typeof raced !== "object") return { ok: false, reason: "ping-bad-reply" };
    if (raced.__timeout) return { ok: false, reason: "ping-timeout" };
    if (raced.nonce !== nonce) return { ok: false, reason: "ping-nonce-mismatch" };
    const state = typeof raced.state === "string" ? raced.state : "";
    if (state !== "ready" && state !== "logged-out" && state !== "loading") {
      return { ok: false, reason: "ping-bad-reply" };
    }
    const detail = (raced.detail && typeof raced.detail === "object") ? raced.detail : {};
    return { ok: true, state, detail };
  } catch (_) {
    // "Receiving end does not exist" — either the tab has no content script
    // yet, or it has an ORPHANED one from before the extension was reloaded.
    return { ok: false, reason: "no-content-script" };
  }
}

async function wasendTabIsOnApp(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!(tab && typeof tab.url === "string" && tab.url.indexOf(WASEND_APP_URL) === 0);
  } catch (_) {
    return false;
  }
}

// A web.whatsapp.com tab the user already has open, or null. Adopting it
// beats opening our own: WhatsApp drives exactly one window and parks every
// other tab on "WhatsApp is open in another window", so a second tab would
// break the run outright.
async function wasendAdoptTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
    if (!tabs || !tabs.length) return null;
    const id = tabs[0].id;
    return id != null ? id : null;
  } catch (_) {
    return null;
  }
}

// Make sure the dedicated tab has WhatsApp up and the content script talking.
// Reusing an already-loaded app with NO reload is the whole point of v2 — a
// run over N items should load the app once, or zero times if the user already
// had it open in this tab. Returns { ok:true, reused } | { ok:false, reason,
// fatal? }; `fatal` means the run itself is over (not logged in).
async function wasendEnsureApp() {
  const r = wasendRun;
  if (!r || r.stopping) return { ok: false, reason: "stopped" };

  // Once per run: take over an already-open WhatsApp tab. If it is already
  // hydrated this makes the whole run zero-reload.
  let adoptedNow = false;
  if (r.tabId === null) {
    const adopted = await wasendAdoptTab();
    if (adopted !== null) {
      r.tabId = adopted;
      adoptedNow = true;
      wasendLog("info", "wasend.app.adopt", { tabId: adopted });
      try {
        await chrome.tabs.update(adopted, { active: true }); // focus, no reload
      } catch (_) { /* still usable even if it can't be focused */ }
    }
  }

  if (r.tabId !== null && (await wasendTabIsOnApp(r.tabId))) {
    const ping = await wasendPingTab(r.tabId);
    if (ping.ok && ping.state === "ready") {
      wasendLog("info", "wasend.app.reuse", { tabId: r.tabId, adopted: adoptedNow, detail: ping.detail });
      return { ok: true, reused: true };
    }
    if (ping.ok && ping.state === "logged-out") {
      return { ok: false, reason: "not-logged-in", fatal: true };
    }
    // We are about to reload a tab the user already had open. Say exactly why,
    // because the most common cause looks like a bug and isn't: reloading the
    // extension orphans the content script in every tab that was already open,
    // so the very first run after a reload always costs one page load.
    if (adoptedNow) {
      wasendLog("warn", "wasend.app.adopt.reload", {
        tabId: r.tabId,
        reason: ping.ok ? ("state:" + ping.state) : ping.reason,
        why: ping.reason === "no-content-script"
          ? "orphaned content script — this tab predates the last extension reload; one reload expected, later runs reuse it"
          : "app not ready yet in the adopted tab",
        detail: ping.detail || {},
      });
    }
  }

  // Plain app URL — no deep link, because chats are switched inside the app.
  if (r.tabId === null) {
    const tab = await chrome.tabs.create({ active: true, url: WASEND_APP_URL });
    r.tabId = tab && tab.id != null ? tab.id : null;
    if (r.tabId === null) return { ok: false, reason: "no-tab" };
  } else {
    await chrome.tabs.update(r.tabId, { url: WASEND_APP_URL, active: true });
  }
  wasendLog("info", "wasend.app.load", { tabId: r.tabId });

  if (r.stopping) return { ok: false, reason: "stopped" };
  if (!(await wasendWaitForLoad(r.tabId))) {
    return { ok: false, reason: r.stopping ? "stopped" : "load-timeout" };
  }
  if (!(await wasendSleep(WASEND_SETTLE_MS))) return { ok: false, reason: "stopped" };

  const until = Date.now() + WASEND_APP_READY_MS;
  let lastPing = { ok: false, reason: "never-pinged" };
  while (Date.now() < until) {
    if (!wasendRun || wasendRun.stopping) return { ok: false, reason: "stopped" };
    const ping = await wasendPingTab(r.tabId);
    if (ping.ok && ping.state === "ready") {
      wasendLog("info", "wasend.app.ready", { tabId: r.tabId, detail: ping.detail });
      return { ok: true, reused: false };
    }
    if (ping.ok && ping.state === "logged-out") {
      return { ok: false, reason: "not-logged-in", fatal: true };
    }
    lastPing = ping;
    if (!(await wasendSleep(1000))) return { ok: false, reason: "stopped" };
  }
  wasendLog("warn", "wasend.app.notReady", {
    tabId: r.tabId,
    reason: lastPing.ok ? ("state:" + lastPing.state) : lastPing.reason,
    detail: lastPing.detail || {},
  });
  return { ok: false, reason: "app-not-ready" };
}

// ── The v1 deep-link path, kept intact as the per-item fallback ──
// Navigates the dedicated tab to /send?phone=…&text=… and lets the content
// script's gate decide. The recipient comes from the URL, so this path cannot
// pick the wrong chat — which is exactly why it is what an ambiguous in-app
// search falls back to.
async function wasendDeliverViaUrl(item, deadlineAt) {
  const r = wasendRun;
  const url = wasendUrlFor(item);
  if (r.tabId === null) {
    const tab = await chrome.tabs.create({ active: true, url });
    r.tabId = tab && tab.id != null ? tab.id : null;
    if (r.tabId === null) return { ok: false, reason: "no-tab" };
  } else {
    await chrome.tabs.update(r.tabId, { url, active: true });
  }
  if (r.stopping) return { ok: false, reason: "stopped" };
  if (!(await wasendWaitForLoad(r.tabId))) {
    return { ok: false, reason: r.stopping ? "stopped" : "load-timeout" };
  }
  if (!(await wasendSleep(WASEND_SETTLE_MS))) return { ok: false, reason: "stopped" };
  return await wasendDeliver(r.tabId, item, deadlineAt);
}

// ── The run ──
async function wasendRunQueue() {
  const r = wasendRun;
  for (let i = 0; i < r.items.length; i++) {
    if (r.stopping) break;
    const item = r.items[i];
    r.index = i + 1;
    wasendPublish("running");
    wasendLog("info", "wasend.item.start", { n: r.index, of: r.items.length, phone: item.phone, chars: item.text.length });

    let reason = "";
    let ok = false;
    let mode = "";
    let tryUrl = false;
    let diag = "";

    try {
      // ── primary: in-app, on the app we already have loaded ──
      const app = await wasendEnsureApp();
      if (!app.ok) {
        reason = app.reason;
        if (app.fatal) wasendStop(app.reason);
        // The deep-link path does its own navigation and load wait, so it is
        // still worth a try when the app merely failed to come up.
        else if (reason !== "stopped") tryUrl = true;
      } else {
        mode = "in-app";
        const res = await wasendDeliverInApp(r.tabId, item, Date.now() + WASEND_ITEM_DEADLINE_MS);
        ok = res.ok === true;
        reason = ok ? "" : (res.reason || "unknown");
        diag = res.diag || "";
        if (!ok && reason === "not-logged-in") wasendStop(reason);
        else tryUrl = !ok && res.fallback === true;
      }

      // ── fallback: this item only, through the v1 deep link ──
      if (!ok && tryUrl && !r.stopping) {
        // reason + diag on ONE line: the content script's own log is about to
        // be destroyed by this navigation.
        wasendLog("warn", "wasend.item.fallback", {
          n: r.index, reason: reason || "unknown", diag: diag || "(none)",
        });
        const first = reason;
        mode = "url";
        const res = await wasendDeliverViaUrl(item, Date.now() + WASEND_ITEM_DEADLINE_MS);
        ok = res.ok === true;
        reason = ok ? "" : ((first ? first + " → " : "") + (res.reason || "unknown")).slice(0, 80);
      }
    } catch (err) {
      ok = false;
      reason = "error:" + ((err && err.message) || "unknown").slice(0, 60);
    }

    r.lastMode = mode;
    r.report.push({ phone: item.phone, mode: mode || "none", ok, reason: reason || "" });
    if (ok) {
      r.sent++;
      wasendLog("action", "wasend.item.sent", { n: r.index, phone: item.phone, chars: item.text.length, mode });
    } else {
      r.failed++;
      r.lastError = reason;
      wasendLog("warn", "wasend.item.fail", {
        n: r.index, phone: item.phone, chars: item.text.length,
        reason, mode: mode || "none", diag: diag || "(none)",
      });
    }
    wasendPublish("running", { lastError: r.lastError || "" });

    if (r.stopping) break;
    if (i < r.items.length - 1) {
      const gap = WASEND_MIN_GAP_MS + Math.floor(Math.random() * (WASEND_MAX_GAP_MS - WASEND_MIN_GAP_MS + 1));
      wasendLog("debug", "wasend.gap", { ms: gap });
      if (!(await wasendSleep(gap))) break;
    }
  }
}

async function wasendStart(queue) {
  if (wasendRun) return { ok: false, error: "a run is already active" };
  const checked = wasendValidateQueue(queue);
  if (checked.error) {
    wasendLog("warn", "wasend.start.rejected", { error: checked.error });
    return { ok: false, error: checked.error };
  }

  wasendRun = {
    tabId: null,
    items: checked.items,
    index: 0,
    sent: 0,
    failed: 0,
    lastMode: "",
    report: [], // [{ phone, mode, ok, reason }] — dumped once at finish
    stopping: false,
    stopReason: "",
    lastError: "",
  };
  // Run separator: the ring outlives every run, so a multi-run export needs a
  // visible boundary between them.
  wasendLog("info", "wasend.run.separator", {
    started: new Date().toISOString(),
    total: checked.items.length,
  });
  wasendLog("action", "wasend.start", { total: checked.items.length });
  wasendPublish("running");

  // Fire and forget — the popup gets progress through storage, not this reply.
  (async () => {
    try {
      await wasendRunQueue();
    } catch (err) {
      wasendRun.lastError = "error:" + ((err && err.message) || "unknown").slice(0, 60);
      wasendLog("error", "wasend.run.error", { error: wasendRun.lastError });
    } finally {
      // Always finalize — never leave "running" dangling.
      const stopped = wasendRun.stopping;
      const final = wasendSnapshot(stopped ? "stopped" : "done", {
        lastError: wasendRun.lastError || wasendRun.stopReason || "",
      });
      wasendLog("action", "wasend.finish", {
        state: final.state, total: final.total, sent: final.sent, failed: final.failed,
        reason: wasendRun.stopReason || "",
      });
      // One line per item, after the fact — which path each recipient actually
      // went through, in a form that can be pasted back verbatim.
      wasendLog("info", "wasend.run.report", { items: wasendRun.report });
      wasendRun = null;
      wasendWriteStatus(final);
    }
  })();

  return { ok: true, total: checked.items.length };
}

function wasendStop(reason) {
  if (!wasendRun) return { ok: false, error: "no run in progress" };
  wasendRun.stopping = true;
  wasendRun.stopReason = reason || "stopped";
  wasendLog("action", "wasend.stop", { reason: wasendRun.stopReason, sent: wasendRun.sent, failed: wasendRun.failed });
  return { ok: true };
}

// The user closing the dedicated tab is an abort signal.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (wasendRun && wasendRun.tabId === tabId) wasendStop("tab-closed");
});

// ── The content script's diagnostics channel ──
// wasend.js fires its decision points here because the page console dies with
// every navigation (and the URL fallback navigates). Fire-and-forget from the
// page's side; strictly shape-validated on this side, and the payload is a
// structural summary — counts, selector variant names, lengths, hashes.
const WASEND_LOG_MAX_CHARS = 500;

function wasendLogFromPage(msg, sender) {
  if (typeof msg.nonce !== "string" || !msg.nonce || msg.nonce.length > 64) return;
  if (typeof msg.event !== "string" || !msg.event || msg.event.length > 64) return;
  if (msg.data != null && (typeof msg.data !== "object" || Array.isArray(msg.data))) return;
  let data = "";
  try {
    data = JSON.stringify(msg.data || {}).slice(0, WASEND_LOG_MAX_CHARS);
  } catch (_) {
    data = "[unserializable]";
  }
  wasendLog("info", "wasend.cs→bg " + msg.event.slice(0, 64), {
    tab: sender && sender.tab ? sender.tab.id : null,
    run: msg.nonce.slice(0, 6),
    data,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "wasend.log") {
    // Page-originated (CLAUDE.md): validated, never re-dispatched anywhere.
    if (!sender || sender.id !== chrome.runtime.id) return;
    wasendLogFromPage(msg, sender);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "wasend.start") {
    if (!sender || sender.id !== chrome.runtime.id) return;
    wasendStart(msg.queue)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || "unknown" }));
    return true; // async sendResponse
  }
  if (msg.type === "wasend.stop") {
    if (!sender || sender.id !== chrome.runtime.id) return;
    sendResponse(wasendStop("user-stop"));
    return true;
  }
  if (msg.type === "exportWasendLog") {
    if (!sender || sender.id !== chrome.runtime.id) return;
    wasendLogReady.then(() => {
      sendResponse({ entries: wasendLogRing.slice(), cap: WASEND_LOG_CAP });
    });
    return true; // async sendResponse
  }
});

// Boot fixup: if the service worker was killed mid-run the stored status is
// stuck at "running" with no run behind it. Reconcile once on wake.
(async () => {
  try {
    const d = await chrome.storage.local.get([WASEND_STATUS_KEY]);
    const st = d[WASEND_STATUS_KEY];
    if (!st || st.state !== "running") return;
    if (wasendRun) return; // a fresh run started while we were reading
    wasendLog("warn", "wasend.orphaned", { sent: st.sent, failed: st.failed, total: st.total });
    wasendWriteStatus(Object.assign({}, st, {
      state: "stopped",
      lastError: "interrupted — the extension's background worker restarted",
      ts: Date.now(),
    }));
  } catch (err) {
    wasendLog("warn", "wasend.orphan.check.fail", { error: err && err.message });
  }
})();

// ═══════════════════════════════════
//  Install / upgrade hooks
// ═══════════════════════════════════
chrome.runtime.onInstalled.addListener(() => {
  SL.log.info("bg", "onInstalled");

  // One-time cleanup of orphaned keys from removed features. Idempotent.
  const ORPHAN_KEYS = [
    "xdim_enabled", "xdim_theme", "xdim_customHue",          // X Dim (removed)
    "acr_host", "acr_key", "acr_secret", "music_history",    // Music Recognizer (removed)
    "nfe_enabled",                                            // NFE — old global key, now per-site
    "enabled", "timeoutMin", "exclusions", "closed_tabs",    // Tab Cleaner (removed)
    "sl_prefs_baseline",                                      // Tab Cleaner personal-defaults sentinel
  ];
  chrome.storage.local.remove(ORPHAN_KEYS, () => {
    SL.log.info("bg", "orphan.cleanup", { keys: ORPHAN_KEYS });
  });

  // Migrate the old single bounce toggle to the new per-platform toggles. When
  // `focus_redirect_enabled` was ON it bounced every platform, so seed all four
  // per-platform keys; either way drop the legacy key. Idempotent — once the
  // key is gone this is a no-op. (Kept out of ORPHAN_KEYS above so we can read
  // its value before removing it.)
  chrome.storage.local.get(["focus_redirect_enabled"], (d) => {
    if (d.focus_redirect_enabled === undefined) return; // nothing to migrate
    const seed = d.focus_redirect_enabled === true
      ? { focus_redirect_youtube: true, focus_redirect_linkedin: true, focus_redirect_facebook: true, focus_redirect_instagram: true }
      : {};
    chrome.storage.local.set(seed, () => {
      chrome.storage.local.remove(["focus_redirect_enabled"], () => {
        SL.log.info("bg", "focusRedirect.migrated", { seeded: Object.keys(seed).length > 0 });
      });
    });
  });

  // Also drop the orphan session-storage key from the old Tab Cleaner tabActivity.
  chrome.storage.session.remove(["sl_tabActivity"]).catch(() => {});
});
