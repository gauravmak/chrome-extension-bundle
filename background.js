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
const TEAMS_LOG_CAP = 500;
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
    bgTeamsReport("info", "teams.http.fail", {
      status: d.statusCode,
      method: d.method,
      type: d.type,
      url: d.url.slice(0, 220),
      tabId: d.tabId,
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
