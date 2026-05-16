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

// Respond to popup requests
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

  // Also drop the orphan session-storage key from the old Tab Cleaner tabActivity.
  chrome.storage.session.remove(["sl_tabActivity"]).catch(() => {});
});
