// ═══════════════════════════════════
//  Navigation
// ═══════════════════════════════════
function switchToPage(page) {
  document.querySelectorAll(".nav button").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`.nav button[data-page="${page}"]`);
  if (!btn) return;
  btn.classList.add("active");
  document.getElementById("page-" + page).classList.add("active");
  if (page === "cookies") loadCookies();
  if (page === "redirects") loadRedirects();
  if (page === "darkmode") loadDarkMode();
  if (page === "jstoggle") loadJsToggle();
  if (page === "nocookie") loadNoCookie();
  if (page === "livecss") loadLiveCSS();
  if (page === "focus") loadFocus();
  if (page === "jsonformat") loadJsonFormat();
  if (page === "localhost") loadLocalhost();
  chrome.storage.local.set({ last_tab: page });
}

document.querySelectorAll(".nav button").forEach((btn) => {
  btn.addEventListener("click", () => switchToPage(btn.dataset.page));
});

// Restore last open tab
chrome.storage.local.get(["last_tab"], (data) => {
  if (data.last_tab) switchToPage(data.last_tab);
});

// ═══════════════════════════════════
//  Tab Cleaner
// ═══════════════════════════════════
const enabledEl = document.getElementById("enabled");
const timeoutEl = document.getElementById("timeout");
const hostInput = document.getElementById("hostInput");
const addBtn = document.getElementById("addBtn");
const listEl = document.getElementById("list");

chrome.storage.local.get(["enabled", "timeoutMin", "exclusions"], (data) => {
  enabledEl.checked = data.enabled !== false;
  timeoutEl.value = data.timeoutMin || 5;
  renderExclusionList(data.exclusions || []);
});

enabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledEl.checked });
});

timeoutEl.addEventListener("change", () => {
  const val = Math.max(1, Math.min(1440, parseInt(timeoutEl.value) || 5));
  timeoutEl.value = val;
  chrome.storage.local.set({ timeoutMin: val });
});

function addHost() {
  let host = hostInput.value.trim().toLowerCase();
  if (!host) return;
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  chrome.storage.local.get(["exclusions"], (data) => {
    const exclusions = data.exclusions || [];
    if (exclusions.includes(host)) { hostInput.value = ""; return; }
    exclusions.push(host);
    chrome.storage.local.set({ exclusions }, () => {
      hostInput.value = "";
      renderExclusionList(exclusions);
    });
  });
}

addBtn.addEventListener("click", addHost);
hostInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addHost(); });

function removeHost(host) {
  chrome.storage.local.get(["exclusions"], (data) => {
    const exclusions = (data.exclusions || []).filter((h) => h !== host);
    chrome.storage.local.set({ exclusions }, () => renderExclusionList(exclusions));
  });
}

function renderExclusionList(exclusions) {
  if (!exclusions.length) {
    listEl.innerHTML = '<div class="empty">No exclusions — all tabs can be closed</div>';
    return;
  }
  listEl.innerHTML = exclusions
    .map((h) => `<div class="item"><span>${esc(h)}</span><button data-host="${escA(h)}">&times;</button></div>`)
    .join("");
  listEl.querySelectorAll("button[data-host]").forEach((btn) => {
    btn.addEventListener("click", () => removeHost(btn.dataset.host));
  });
}

// ── Closed Tabs History ──
const closedSection = document.getElementById("closedSection");

function loadClosedTabs() {
  chrome.storage.local.get(["closed_tabs"], (data) => {
    const closed = data.closed_tabs || [];
    if (!closed.length) {
      closedSection.innerHTML = "";
      return;
    }
    closedSection.innerHTML = `
      <div class="closed-header">
        <h2>Recently Closed</h2>
        <button id="clearClosed">Clear</button>
      </div>
    ` + closed.map((t, i) => `
      <div class="closed-item" data-url="${escA(t.url)}" data-idx="${i}">
        ${t.favIconUrl ? `<img class="favicon" src="${escA(t.favIconUrl)}" onerror="this.style.display='none'">` : '<div class="favicon"></div>'}
        <span class="closed-title" title="${escA(t.url)}">${esc(t.title)}</span>
        <span class="closed-time">${timeAgo(t.time)}</span>
        <button class="reopen" title="Re-open">↗</button>
      </div>
    `).join("");

    document.getElementById("clearClosed").addEventListener("click", () => {
      chrome.storage.local.remove("closed_tabs", loadClosedTabs);
    });

    closedSection.querySelectorAll(".closed-item").forEach((item) => {
      item.addEventListener("click", () => {
        chrome.tabs.create({ url: item.dataset.url });
      });
    });
  });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

loadClosedTabs();

// ═══════════════════════════════════
//  Cookie Editor
// ═══════════════════════════════════
const cookieDomainEl = document.getElementById("cookieDomain");
const cookieCountEl = document.getElementById("cookieCount");
const cookieListEl = document.getElementById("cookieList");

let currentUrl = "";
let currentDomain = "";
let allCookies = [];

async function loadCookies() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    cookieDomainEl.textContent = "No accessible page";
    cookieCountEl.textContent = "0";
    cookieListEl.innerHTML = '<div class="empty">Cannot read cookies from this page</div>';
    return;
  }
  currentUrl = tab.url;
  try {
    currentDomain = new URL(tab.url).hostname;
  } catch {
    currentDomain = "";
  }
  cookieDomainEl.textContent = currentDomain;

  const cookies = await chrome.cookies.getAll({ url: tab.url });
  cookies.sort((a, b) => a.name.localeCompare(b.name));
  allCookies = cookies;
  cookieCountEl.textContent = cookies.length;
  renderCookies(cookies);
}

function renderCookies(cookies) {
  if (!cookies.length) {
    cookieListEl.innerHTML = '<div class="empty">No cookies for this site</div>';
    return;
  }
  cookieListEl.innerHTML = cookies.map((c, i) => `
    <div class="cookie-item" data-idx="${i}">
      <div class="cookie-row">
        <span class="cookie-chevron">&#9660;</span>
        <span class="cookie-name">${esc(c.name)}</span>
        <button class="cookie-del" data-delidx="${i}" title="Delete">&times;</button>
      </div>
      <div class="cookie-details">
        <div class="cookie-field">
          <label>Name</label>
          <input type="text" value="${escA(c.name)}" data-field="name" data-i="${i}">
        </div>
        <div class="cookie-field">
          <label>Value</label>
          <textarea data-field="value" data-i="${i}">${esc(c.value)}</textarea>
        </div>
        <div class="advanced-toggle" data-adv="${i}">Show Advanced</div>
        <div class="advanced-fields" data-advf="${i}">
          <div class="cookie-field">
            <label>Domain</label>
            <input type="text" value="${escA(c.domain)}" data-field="domain" data-i="${i}">
          </div>
          <div class="cookie-field">
            <label>Path</label>
            <input type="text" value="${escA(c.path)}" data-field="path" data-i="${i}">
          </div>
          <div class="cookie-field">
            <label>SameSite</label>
            <input type="text" value="${escA(c.sameSite || "unspecified")}" data-field="sameSite" data-i="${i}">
          </div>
          <div class="cookie-field">
            <label>Secure: ${c.secure ? "Yes" : "No"} &nbsp;|&nbsp; HttpOnly: ${c.httpOnly ? "Yes" : "No"}</label>
          </div>
        </div>
        <div class="cookie-actions">
          <button class="btn-save" data-saveidx="${i}">&#128190; Save</button>
          <button class="btn-del2" data-delidx="${i}">&#128465; Delete</button>
        </div>
      </div>
    </div>
  `).join("");

  // Expand / collapse
  cookieListEl.querySelectorAll(".cookie-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".cookie-del")) return;
      row.closest(".cookie-item").classList.toggle("expanded");
    });
  });

  // Show Advanced
  cookieListEl.querySelectorAll(".advanced-toggle").forEach((t) => {
    t.addEventListener("click", () => {
      const fields = cookieListEl.querySelector(`.advanced-fields[data-advf="${t.dataset.adv}"]`);
      fields.classList.toggle("show");
      t.textContent = fields.classList.contains("show") ? "Hide Advanced" : "Show Advanced";
    });
  });

  // Delete buttons
  cookieListEl.querySelectorAll("[data-delidx]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCookie(allCookies[parseInt(btn.dataset.delidx)]);
    });
  });

  // Save buttons
  cookieListEl.querySelectorAll("[data-saveidx]").forEach((btn) => {
    btn.addEventListener("click", () => saveCookie(parseInt(btn.dataset.saveidx)));
  });
}

async function deleteCookie(cookie) {
  const protocol = cookie.secure ? "https" : "http";
  const url = `${protocol}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
  await chrome.cookies.remove({ url, name: cookie.name });
  loadCookies();
}

async function saveCookie(idx) {
  const original = allCookies[idx];
  const item = cookieListEl.querySelector(`.cookie-item[data-idx="${idx}"]`);

  const nameEl = item.querySelector('[data-field="name"]');
  const valueEl = item.querySelector('[data-field="value"]');
  const domainEl = item.querySelector('[data-field="domain"]');
  const pathEl = item.querySelector('[data-field="path"]');
  const sameSiteEl = item.querySelector('[data-field="sameSite"]');

  // Remove old cookie first
  const protocol = original.secure ? "https" : "http";
  const oldUrl = `${protocol}://${original.domain.replace(/^\./, "")}${original.path}`;
  await chrome.cookies.remove({ url: oldUrl, name: original.name });

  const domain = domainEl ? domainEl.value : original.domain;
  const path = pathEl ? pathEl.value : original.path;
  const newUrl = `${protocol}://${domain.replace(/^\./, "")}${path}`;

  const details = {
    url: newUrl,
    name: nameEl.value,
    value: valueEl.value,
    path: path,
    secure: original.secure,
    httpOnly: original.httpOnly,
    sameSite: sameSiteEl ? sameSiteEl.value : original.sameSite || "unspecified",
  };
  if (!original.hostOnly) details.domain = domain;
  if (original.expirationDate) details.expirationDate = original.expirationDate;

  await chrome.cookies.set(details);
  loadCookies();
}

// Delete All
document.getElementById("btnDeleteAll").addEventListener("click", async () => {
  if (!allCookies.length) return;
  for (const c of allCookies) {
    const protocol = c.secure ? "https" : "http";
    const url = `${protocol}://${c.domain.replace(/^\./, "")}${c.path}`;
    await chrome.cookies.remove({ url, name: c.name });
  }
  loadCookies();
});

// Refresh
document.getElementById("btnRefresh").addEventListener("click", () => loadCookies());

// Export
document.getElementById("btnExport").addEventListener("click", () => {
  if (!allCookies.length) return;
  const data = JSON.stringify(allCookies, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cookies-${currentDomain}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Add Cookie Modal
const addModal = document.getElementById("addModal");
document.getElementById("btnAdd").addEventListener("click", () => {
  document.getElementById("newDomain").value = currentDomain ? "." + currentDomain : "";
  document.getElementById("newPath").value = "/";
  document.getElementById("newName").value = "";
  document.getElementById("newValue").value = "";
  addModal.classList.add("show");
});
document.getElementById("modalCancel").addEventListener("click", () => {
  addModal.classList.remove("show");
});
addModal.addEventListener("click", (e) => {
  if (e.target === addModal) addModal.classList.remove("show");
});
document.getElementById("modalSave").addEventListener("click", async () => {
  const name = document.getElementById("newName").value.trim();
  if (!name) return;
  const domain = document.getElementById("newDomain").value.trim();
  const path = document.getElementById("newPath").value.trim() || "/";
  const url = `https://${domain.replace(/^\./, "")}${path}`;
  await chrome.cookies.set({
    url,
    name,
    value: document.getElementById("newValue").value,
    domain,
    path,
  });
  addModal.classList.remove("show");
  loadCookies();
});

// ═══════════════════════════════════
//  Redirect Tracer
// ═══════════════════════════════════
const redirectChainEl = document.getElementById("redirectChain");
let lastRedirectText = "";

async function loadRedirects() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    redirectChainEl.innerHTML = '<div class="redirect-empty"><div class="big-icon">🔀</div><p>No active tab</p></div>';
    return;
  }

  const data = await chrome.runtime.sendMessage({ type: "getRedirects", tabId: tab.id });
  const chain = data.chain || [];
  const finalUrl = data.finalUrl || tab.url;
  const finalStatus = data.finalStatus || 200;

  if (!chain.length) {
    // No redirects — just show the final URL
    redirectChainEl.innerHTML = renderStep(finalUrl, finalStatus, true, false);
    lastRedirectText = `${finalUrl}\n${finalStatus}: Final destination`;
    return;
  }

  let html = "";
  let text = "";
  chain.forEach((hop, i) => {
    const label = getRedirectLabel(hop.statusCode);
    html += renderStep(hop.url, hop.statusCode, false, true);
    text += `${hop.url}\n${hop.statusCode}: ${label} to ${hop.redirectUrl}\n\n`;
  });
  // Final destination
  html += renderStep(finalUrl, finalStatus, true, false);
  text += `${finalUrl}\n${finalStatus}: Final destination`;

  redirectChainEl.innerHTML = html;
  lastRedirectText = text;
}

function renderStep(url, statusCode, isFinal, hasConnector) {
  const iconClass = isFinal ? (statusCode >= 400 ? "error" : "final") : "redirect";
  const codeClass = statusCode >= 500 ? "code-5xx" : statusCode >= 400 ? "code-4xx" : `code-${statusCode}`;
  const label = isFinal ? "Final destination" : getRedirectLabel(statusCode);
  const arrow = isFinal
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="#6af38a" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="#6ab0f3" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';

  return `
    <div class="redirect-step">
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div class="step-icon ${iconClass}">${arrow}</div>
        ${hasConnector ? '<div class="step-connector"></div>' : ''}
      </div>
      <div class="step-content">
        <div class="step-url">${esc(url)}</div>
        <div class="step-status"><span class="code ${codeClass}">${statusCode}</span> ${esc(label)}</div>
      </div>
    </div>
  `;
}

function getRedirectLabel(code) {
  const labels = {
    301: "Permanent redirect",
    302: "Temporary redirect (Found)",
    303: "See Other",
    307: "Temporary redirect",
    308: "Permanent redirect",
  };
  return labels[code] || `Redirect (${code})`;
}

document.getElementById("btnRedirectRefresh").addEventListener("click", () => loadRedirects());

document.getElementById("btnRedirectCopy").addEventListener("click", async () => {
  if (!lastRedirectText) return;
  await navigator.clipboard.writeText(lastRedirectText);
  const btn = document.getElementById("btnRedirectCopy");
  const orig = btn.querySelector("span").textContent;
  btn.querySelector("span").textContent = "Copied!";
  setTimeout(() => { btn.querySelector("span").textContent = orig; }, 1500);
});

// ═══════════════════════════════════
//  Dark Mode
// ═══════════════════════════════════
const darkToggle = document.getElementById("darkToggle");
const darkStatus = document.getElementById("darkStatus");
const darkHostEl = document.getElementById("darkHost");
const darkBrightness = document.getElementById("darkBrightness");
const darkBrightnessVal = document.getElementById("darkBrightnessVal");
const scopeSite = document.getElementById("scopeSite");
const scopeGlobal = document.getElementById("scopeGlobal");

let darkHost = "";
let darkScope = "site"; // "site" or "global"

async function loadDarkMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  try { darkHost = new URL(tab.url).hostname; } catch { darkHost = ""; }
  darkHostEl.textContent = darkHost ? `Current site: ${darkHost}` : "";

  const siteKey = "darkmode_" + darkHost;
  const data = await chrome.storage.local.get([siteKey, "darkmode_global", "darkmode_brightness"]);

  const brightness = data.darkmode_brightness || 100;
  darkBrightness.value = brightness;
  darkBrightnessVal.textContent = brightness + "%";

  const siteState = data[siteKey];
  const globalState = data.darkmode_global || false;
  const enabled = siteState !== undefined ? siteState : globalState;

  darkToggle.checked = enabled;
  updateDarkStatus(enabled);
}

function updateDarkStatus(on) {
  darkStatus.textContent = on ? "ON" : "OFF";
  darkStatus.className = "status " + (on ? "on" : "off");
}

async function applyDark() {
  const enabled = darkToggle.checked;
  const brightness = parseInt(darkBrightness.value);
  updateDarkStatus(enabled);

  // Save preference
  if (darkScope === "global") {
    await chrome.storage.local.set({ darkmode_global: enabled });
  } else {
    const siteKey = "darkmode_" + darkHost;
    await chrome.storage.local.set({ [siteKey]: enabled });
  }
  await chrome.storage.local.set({ darkmode_brightness: brightness });

  // Send to active tab's content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, {
      type: "darkmode_toggle",
      enabled,
      brightness,
    }).catch(() => {});
  }
}

darkToggle.addEventListener("change", applyDark);

darkBrightness.addEventListener("input", () => {
  darkBrightnessVal.textContent = darkBrightness.value + "%";
});
darkBrightness.addEventListener("change", applyDark);

scopeSite.addEventListener("click", () => {
  darkScope = "site";
  scopeSite.classList.add("active");
  scopeGlobal.classList.remove("active");
});
scopeGlobal.addEventListener("click", () => {
  darkScope = "global";
  scopeGlobal.classList.add("active");
  scopeSite.classList.remove("active");
});

// ═══════════════════════════════════
//  Cookie Consent (GDPR) Dismisser
// ═══════════════════════════════════
const nocookieToggle = document.getElementById("nocookieToggle");
const nocookieStatus = document.getElementById("nocookieStatus");

async function loadNoCookie() {
  const data = await chrome.storage.local.get(["nocookie_enabled"]);
  const enabled = data.nocookie_enabled !== false;
  nocookieToggle.checked = enabled;
  updateNoCookieUI(enabled);
}

function updateNoCookieUI(on) {
  nocookieStatus.textContent = on ? "ON" : "OFF";
  nocookieStatus.className = "status " + (on ? "on" : "off");
}

nocookieToggle.addEventListener("change", async () => {
  const enabled = nocookieToggle.checked;
  updateNoCookieUI(enabled);
  await chrome.storage.local.set({ nocookie_enabled: enabled });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "nocookie_toggle", enabled }).catch(() => {});
  }
});

// ═══════════════════════════════════
//  Live CSS Editor
// ═══════════════════════════════════
const livecssHostEl = document.getElementById("livecssHost");
const livecssEditor = document.getElementById("livecssEditor");
const livecssSave = document.getElementById("livecssSave");
const livecssClear = document.getElementById("livecssClear");

let livecssHost = "";

async function loadLiveCSS() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  try { livecssHost = new URL(tab.url).hostname; } catch { livecssHost = ""; }
  livecssHostEl.textContent = livecssHost ? `Editing CSS for: ${livecssHost}` : "No accessible page";

  const key = "livecss_" + livecssHost;
  const data = await chrome.storage.local.get([key]);
  livecssEditor.value = data[key] || "";
}

// Live preview as user types
livecssEditor.addEventListener("input", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "livecss_update", css: livecssEditor.value }).catch(() => {});
  }
});

// Allow Tab key to insert spaces in textarea
livecssEditor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = livecssEditor.selectionStart;
    const end = livecssEditor.selectionEnd;
    livecssEditor.value = livecssEditor.value.substring(0, start) + "  " + livecssEditor.value.substring(end);
    livecssEditor.selectionStart = livecssEditor.selectionEnd = start + 2;
    livecssEditor.dispatchEvent(new Event("input"));
  }
});

livecssSave.addEventListener("click", async () => {
  const key = "livecss_" + livecssHost;
  await chrome.storage.local.set({ [key]: livecssEditor.value });
  livecssSave.textContent = "Saved!";
  setTimeout(() => { livecssSave.textContent = "Save"; }, 1500);
});

livecssClear.addEventListener("click", async () => {
  livecssEditor.value = "";
  const key = "livecss_" + livecssHost;
  await chrome.storage.local.remove(key);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "livecss_update", css: "" }).catch(() => {});
  }
});

// ═══════════════════════════════════
//  Focus Mode — unified hide-distractions per site
// ═══════════════════════════════════
// Storage keys:
//   unhook_enabled       (default ON)   → YouTube unhook.js
//   xunhook_enabled      (default ON)   → X sidebar xunhook.js
//   nfe_x                (default OFF)  → X home timeline nfe.js
//   nfe_linkedin         (default OFF)  → LinkedIn feed nfe.js
//   nfe_facebook         (default OFF)  → Facebook feed nfe.js
//   nfe_reddit           (default OFF)  → Reddit feed nfe.js

const FOCUS_SITES = [
  {
    elId: "focusYoutube",
    storageKey: "unhook_enabled",
    defaultOn: true,
    msgType: "unhook_toggle",
    nfeSite: null,
    urlPatterns: ["*://www.youtube.com/*", "*://m.youtube.com/*"],
  },
  {
    elId: "focusXSidebar",
    storageKey: "xunhook_enabled",
    defaultOn: true,
    msgType: "xunhook_toggle",
    nfeSite: null,
    urlPatterns: ["*://x.com/*", "*://twitter.com/*", "*://mobile.x.com/*", "*://mobile.twitter.com/*"],
  },
  {
    elId: "focusXTimeline",
    storageKey: "nfe_x",
    defaultOn: false,
    msgType: "nfe_toggle",
    nfeSite: "x",
    urlPatterns: ["*://x.com/*", "*://twitter.com/*", "*://mobile.x.com/*", "*://mobile.twitter.com/*"],
  },
  {
    elId: "focusLinkedin",
    storageKey: "nfe_linkedin",
    defaultOn: false,
    msgType: "nfe_toggle",
    nfeSite: "linkedin",
    urlPatterns: ["*://*.linkedin.com/*"],
  },
  {
    elId: "focusFacebook",
    storageKey: "nfe_facebook",
    defaultOn: false,
    msgType: "nfe_toggle",
    nfeSite: "facebook",
    urlPatterns: ["*://*.facebook.com/*"],
  },
  {
    elId: "focusReddit",
    storageKey: "nfe_reddit",
    defaultOn: false,
    msgType: "nfe_toggle",
    nfeSite: "reddit",
    urlPatterns: ["*://*.reddit.com/*"],
  },
];

async function loadFocus() {
  const keys = FOCUS_SITES.map((s) => s.storageKey);
  const data = await chrome.storage.local.get(keys);
  for (const s of FOCUS_SITES) {
    const stored = data[s.storageKey];
    const enabled = stored === undefined ? s.defaultOn : stored === true;
    const el = document.getElementById(s.elId);
    if (el) el.checked = enabled;
  }
}

for (const s of FOCUS_SITES) {
  const el = document.getElementById(s.elId);
  if (!el) continue;
  el.addEventListener("change", async () => {
    const enabled = el.checked;
    await chrome.storage.local.set({ [s.storageKey]: enabled });
    try {
      const tabs = await chrome.tabs.query({ url: s.urlPatterns });
      for (const t of tabs) {
        const msg = { type: s.msgType, enabled };
        if (s.nfeSite) msg.site = s.nfeSite;
        chrome.tabs.sendMessage(t.id, msg).catch(() => {});
      }
    } catch (_) {}
  });
}

// ═══════════════════════════════════
//  JavaScript Toggle
// ═══════════════════════════════════
const jsToggle = document.getElementById("jsToggle");
const jsStatus = document.getElementById("jsStatus");
const jsIndicator = document.getElementById("jsIndicator");
const jsHostLabel = document.getElementById("jsHostLabel");

let jsHost = "";

async function loadJsToggle() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  try { jsHost = new URL(tab.url).hostname; } catch { jsHost = ""; }
  jsHostLabel.textContent = jsHost || "No accessible page";

  if (!jsHost) return;

  if (!chrome.contentSettings || !chrome.contentSettings.javascript) return;
  const pattern = `https://${jsHost}/*`;
  chrome.contentSettings.javascript.get({ primaryUrl: pattern }, (details) => {
    const enabled = details.setting === "allow";
    jsToggle.checked = enabled;
    updateJsUI(enabled);
  });
}

function updateJsUI(enabled) {
  jsStatus.textContent = enabled ? "ENABLED" : "DISABLED";
  jsStatus.className = "status " + (enabled ? "on" : "off");
  jsIndicator.className = "indicator " + (enabled ? "on" : "off");
}

jsToggle.addEventListener("change", async () => {
  const enabled = jsToggle.checked;
  updateJsUI(enabled);

  if (!chrome.contentSettings || !chrome.contentSettings.javascript) return;
  const pattern = `https://${jsHost}/*`;
  chrome.contentSettings.javascript.set({
    primaryPattern: pattern,
    setting: enabled ? "allow" : "block",
  });
  // Also set for http
  chrome.contentSettings.javascript.set({
    primaryPattern: `http://${jsHost}/*`,
    setting: enabled ? "allow" : "block",
  });

  // Reload the tab so the change takes effect
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
});

// ═══════════════════════════════════
//  Picture-in-Picture
// ═══════════════════════════════════
const pipBtn = document.getElementById("pipBtn");
const pipLabel = document.getElementById("pipLabel");
const pipStatus = document.getElementById("pipStatus");

pipBtn.addEventListener("click", enterPiP);

async function enterPiP() {
  pipStatus.textContent = "";
  pipStatus.className = "pip-status";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    pipStatus.textContent = "No active tab";
    pipStatus.className = "pip-status err";
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({ type: "pip", tabId: tab.id });
    if (!result) {
      pipStatus.textContent = "Could not access page";
      pipStatus.className = "pip-status err";
    } else if (result.error) {
      pipStatus.textContent = result.error;
      pipStatus.className = "pip-status err";
    } else if (result.action === "entered") {
      pipStatus.textContent = "Video in Picture-in-Picture";
      pipStatus.className = "pip-status ok";
      pipBtn.classList.add("active");
    } else if (result.action === "exited") {
      pipStatus.textContent = "Exited Picture-in-Picture";
      pipStatus.className = "pip-status ok";
      pipBtn.classList.remove("active");
    }
  } catch (err) {
    pipStatus.textContent = err.message;
    pipStatus.className = "pip-status err";
  }
}

// ═══════════════════════════════════
//  JSON Formatter
// ═══════════════════════════════════
const jsonformatToggle = document.getElementById("jsonformatToggle");
const jsonformatStatus = document.getElementById("jsonformatStatus");

async function loadJsonFormat() {
  const data = await chrome.storage.local.get(["jsonformat_enabled"]);
  const enabled = data.jsonformat_enabled !== false;
  jsonformatToggle.checked = enabled;
  updateJsonFormatUI(enabled);
}

function updateJsonFormatUI(on) {
  jsonformatStatus.textContent = on ? "ON" : "OFF";
  jsonformatStatus.className = "status " + (on ? "on" : "off");
}

jsonformatToggle.addEventListener("change", async () => {
  const enabled = jsonformatToggle.checked;
  updateJsonFormatUI(enabled);
  await chrome.storage.local.set({ jsonformat_enabled: enabled });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "jsonformat_toggle", enabled }).catch(() => {});
  }
});

// ═══════════════════════════════════
//  Quick Actions — Reading Material, Markdown, Calendar
// ═══════════════════════════════════
const READING_FOLDER_NAME = "Reading Material";
const quickStatus = document.getElementById("quickStatus");

function setQuickStatus(msg, kind) {
  quickStatus.textContent = msg || "";
  quickStatus.className = "quick-status" + (kind ? " " + kind : "");
  if (msg) {
    setTimeout(() => {
      if (quickStatus.textContent === msg) {
        quickStatus.textContent = "";
        quickStatus.className = "quick-status";
      }
    }, 2500);
  }
}

function flashButton(btn) {
  btn.classList.add("flash");
  setTimeout(() => btn.classList.remove("flash"), 1200);
}

async function findOrCreateReadingFolder() {
  // Walk the tree and find a folder named "Reading Material" under any root.
  // If multiple exist, prefer the one under the bookmarks bar (id "1").
  const tree = await chrome.bookmarks.getTree();
  let preferred = null;
  let fallback = null;
  function walk(node, underBar) {
    if (!node) return;
    if (!node.url && node.title === READING_FOLDER_NAME) {
      if (underBar && !preferred) preferred = node;
      else if (!fallback) fallback = node;
    }
    for (const child of node.children || []) {
      walk(child, underBar || node.id === "1");
    }
  }
  for (const root of tree) walk(root, false);
  if (preferred) return preferred.id;
  if (fallback) return fallback.id;
  // Create under the bookmarks bar (id "1")
  const created = await chrome.bookmarks.create({ parentId: "1", title: READING_FOLDER_NAME });
  return created.id;
}

document.getElementById("qbReading").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) { setQuickStatus("No active tab", "err"); return; }
    if (/^chrome:\/\//.test(tab.url) || /^chrome-extension:\/\//.test(tab.url)) {
      setQuickStatus("Can't bookmark Chrome internal pages", "err");
      return;
    }
    const parentId = await findOrCreateReadingFolder();
    // Avoid creating a duplicate if the same URL already lives in the folder.
    const existing = await chrome.bookmarks.search({ url: tab.url });
    const already = existing.find((b) => b.parentId === parentId);
    if (already) {
      setQuickStatus("Already saved", "ok");
      flashButton(btn);
      return;
    }
    await chrome.bookmarks.create({ parentId, title: tab.title || tab.url, url: tab.url });
    setQuickStatus("Saved to Reading Material", "ok");
    flashButton(btn);
  } catch (err) {
    setQuickStatus(err.message || "Failed to save", "err");
  }
});

document.getElementById("qbMarkdown").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { setQuickStatus("No active tab", "err"); return; }
    if (/^chrome:\/\//.test(tab.url || "") || /^chrome-extension:\/\//.test(tab.url || "")) {
      setQuickStatus("Can't read Chrome internal pages", "err");
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractMarkdownFromPage,
    });
    const out = results && results[0] && results[0].result;
    if (!out || !out.md) {
      setQuickStatus("Nothing to convert", "err");
      return;
    }
    await navigator.clipboard.writeText(out.md);
    const label = out.source === "selection" ? "Selection copied" : "Article copied";
    setQuickStatus(`${label} (${out.md.length} chars)`, "ok");
    flashButton(btn);
  } catch (err) {
    setQuickStatus(err.message || "Failed", "err");
  }
});

// Runs in the page context via chrome.scripting.executeScript
function extractMarkdownFromPage() {
  function toMd(root) {
    const out = [];
    function emit(s) { out.push(s); }
    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        emit(node.textContent.replace(/\s+/g, " "));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "iframe" || tag === "svg" || tag === "nav" || tag === "footer" || tag === "aside") return;
      const collectInner = () => {
        const before = out.length;
        for (const c of node.childNodes) walk(c);
        const slice = out.splice(before).join("");
        return slice;
      };
      switch (tag) {
        case "h1": emit("\n\n# " + collectInner().trim() + "\n\n"); return;
        case "h2": emit("\n\n## " + collectInner().trim() + "\n\n"); return;
        case "h3": emit("\n\n### " + collectInner().trim() + "\n\n"); return;
        case "h4": emit("\n\n#### " + collectInner().trim() + "\n\n"); return;
        case "h5": emit("\n\n##### " + collectInner().trim() + "\n\n"); return;
        case "h6": emit("\n\n###### " + collectInner().trim() + "\n\n"); return;
        case "p":  emit("\n\n" + collectInner().trim() + "\n\n"); return;
        case "br": emit("\n"); return;
        case "hr": emit("\n\n---\n\n"); return;
        case "a": {
          const text = collectInner().trim();
          const href = node.getAttribute("href") || "";
          emit(href && text ? `[${text}](${href})` : text);
          return;
        }
        case "strong": case "b": emit("**" + collectInner() + "**"); return;
        case "em": case "i": emit("*" + collectInner() + "*"); return;
        case "code": {
          const parent = node.parentNode && node.parentNode.tagName;
          if (parent === "PRE") { emit(collectInner()); return; }
          emit("`" + collectInner() + "`"); return;
        }
        case "pre": emit("\n\n```\n" + (node.textContent || "").replace(/\n+$/, "") + "\n```\n\n"); return;
        case "blockquote": {
          const text = collectInner().trim();
          emit("\n\n" + text.split("\n").map((l) => "> " + l).join("\n") + "\n\n");
          return;
        }
        case "ul": case "ol": emit("\n" + collectInner() + "\n"); return;
        case "li": {
          const ordered = node.parentNode && node.parentNode.tagName === "OL";
          emit((ordered ? "1. " : "- ") + collectInner().trim() + "\n");
          return;
        }
        case "img": {
          const alt = node.getAttribute("alt") || "";
          const src = node.getAttribute("src") || "";
          if (src) emit(`![${alt}](${src})`);
          return;
        }
        case "table": case "thead": case "tbody": case "tr": case "th": case "td":
          emit(collectInner() + " "); return;
        default:
          emit(collectInner()); return;
      }
    }
    walk(root);
    return out.join("").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  }

  const sel = window.getSelection();
  if (sel && String(sel).trim()) {
    const range = sel.getRangeAt(0);
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    return { md: toMd(container), source: "selection" };
  }
  const root =
    document.querySelector("article") ||
    document.querySelector('[role="main"]') ||
    document.querySelector("main") ||
    document.body;
  const body = toMd(root);
  const header = `# ${document.title || ""}\n\n${location.href}\n\n---\n\n`;
  return { md: header + body, source: "article" };
}

document.getElementById("qbPickColor").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { setQuickStatus("No active tab", "err"); return; }
    if (/^chrome:\/\//.test(tab.url || "") || /^chrome-extension:\/\//.test(tab.url || "")) {
      setQuickStatus("Can't pick on Chrome pages", "err");
      return;
    }
    setQuickStatus("Click anywhere on the page…", "ok");
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pickColorInPage,
    });
    const r = res && res[0] && res[0].result;
    if (r && r.hex) {
      setQuickStatus(`Picked ${r.hex} — copied`, "ok");
      flashButton(btn);
    } else if (r && r.error) {
      setQuickStatus(r.error, "err");
    }
  } catch (err) {
    setQuickStatus(err.message || "Failed", "err");
  }
});

// Runs in page context. EyeDropper API is Chrome 95+.
async function pickColorInPage() {
  if (typeof window.EyeDropper !== "function") {
    return { error: "EyeDropper requires Chrome 95+" };
  }
  try {
    const eye = new window.EyeDropper();
    const result = await eye.open();
    try { await navigator.clipboard.writeText(result.sRGBHex); } catch (_) {}
    const toast = document.createElement("div");
    toast.textContent = `Copied ${result.sRGBHex}`;
    toast.style.cssText =
      "position:fixed;top:20px;right:20px;background:#1a1a2e;color:#fff;" +
      "padding:12px 16px;border-radius:8px;border:1px solid #e94560;" +
      "font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "z-index:2147483647;box-shadow:0 4px 20px rgba(0,0,0,0.4);" +
      "display:flex;align-items:center;gap:10px;";
    const swatch = document.createElement("span");
    swatch.style.cssText = `display:inline-block;width:16px;height:16px;border-radius:3px;background:${result.sRGBHex};border:1px solid #fff;`;
    toast.prepend(swatch);
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
    return { hex: result.sRGBHex };
  } catch (e) {
    return { error: (e && e.message) || "Cancelled" };
  }
}

document.getElementById("qbFillForm").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { setQuickStatus("No active tab", "err"); return; }
    if (/^chrome:\/\//.test(tab.url || "") || /^chrome-extension:\/\//.test(tab.url || "")) {
      setQuickStatus("Can't fill on Chrome pages", "err");
      return;
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: fillFormsInPage,
    });
    const total = (res || []).reduce((acc, r) => acc + ((r && r.result && r.result.filled) || 0), 0);
    if (total > 0) {
      setQuickStatus(`Filled ${total} field${total === 1 ? "" : "s"}`, "ok");
      flashButton(btn);
    } else {
      setQuickStatus("No fillable fields found", "err");
    }
  } catch (err) {
    setQuickStatus(err.message || "Failed", "err");
  }
});

// Runs in page context.
function fillFormsInPage() {
  const ri = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rstr = (n) => Math.random().toString(36).slice(2, 2 + (n || 6));
  const firstNames = ["Alex", "Jordan", "Sam", "Taylor", "Casey", "Morgan", "Riley", "Jamie", "Avery", "Quinn"];
  const lastNames = ["Smith", "Johnson", "Patel", "Garcia", "Chen", "Khan", "Brown", "Davis", "Miller", "Wilson"];
  const cities = ["Austin", "Portland", "Seattle", "Denver", "Chicago", "Boston", "Miami", "Atlanta", "Phoenix", "Dallas"];
  const states = ["TX", "OR", "WA", "CO", "IL", "MA", "FL", "GA", "AZ", "CA"];
  const companies = ["Acme Corp", "Globex", "Initech", "Hooli", "Pied Piper", "Umbrella", "Stark", "Wayne"];
  const streets = ["Main St", "Oak Ave", "Maple Rd", "Elm Way", "Pine Blvd", "Cedar Ln"];

  const fakers = {
    firstName: () => ri(firstNames),
    lastName: () => ri(lastNames),
    fullName: () => `${ri(firstNames)} ${ri(lastNames)}`,
    email: () => `test+${rstr(6)}@example.com`,
    phone: () => "+1" + String(Math.floor(2000000000 + Math.random() * 7999999999)),
    address: () => `${Math.floor(Math.random() * 9990) + 10} ${ri(streets)}`,
    city: () => ri(cities),
    state: () => ri(states),
    zip: () => String(Math.floor(Math.random() * 89999) + 10000),
    country: () => "USA",
    company: () => ri(companies),
    url: () => "https://example.com/" + rstr(4),
    password: () => "Test1234!",
    date: () => new Date().toISOString().slice(0, 10),
    time: () => "12:30",
    datetime: () => new Date().toISOString().slice(0, 16),
    lorem: () => "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    word: () => rstr(7),
  };

  function classify(el) {
    const blob = (
      (el.name || "") + " " +
      (el.id || "") + " " +
      (el.placeholder || "") + " " +
      (el.getAttribute("aria-label") || "") + " " +
      (el.autocomplete || "")
    ).toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (type === "email" || /e-?mail/.test(blob)) return "email";
    if (type === "tel" || /phone|mobile|tel\b/.test(blob)) return "phone";
    if (type === "url" || /\burl\b|website/.test(blob)) return "url";
    if (type === "password") return "password";
    if (type === "number") return "number";
    if (type === "date") return "date";
    if (type === "time") return "time";
    if (type === "datetime-local") return "datetime";
    if (/first.?name|fname|given/.test(blob)) return "firstName";
    if (/last.?name|lname|surname|family/.test(blob)) return "lastName";
    if (/full.?name|^name$|your.?name|display.?name/.test(blob)) return "fullName";
    if (/address|street/.test(blob)) return "address";
    if (/city|town/.test(blob)) return "city";
    if (/state|province|region/.test(blob)) return "state";
    if (/zip|postal/.test(blob)) return "zip";
    if (/country/.test(blob)) return "country";
    if (/company|organi[sz]ation|business|employer/.test(blob)) return "company";
    return null;
  }

  function setValue(el, val) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  let filled = 0;
  const nodes = document.querySelectorAll("input, textarea, select");
  for (const el of nodes) {
    if (el.disabled || el.readOnly) continue;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "file", "image", "reset"].includes(type)) continue;
    // Skip not-rendered fields
    if (!(el instanceof HTMLSelectElement) && el.offsetParent === null && el.type !== "radio" && el.type !== "checkbox") continue;

    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.options).filter((o) => o.value && !o.disabled);
      if (opts.length) {
        el.value = ri(opts).value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled++;
      }
      continue;
    }
    if (type === "checkbox") {
      if (!el.checked) {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled++;
      }
      continue;
    }
    if (type === "radio") {
      if (el.name) {
        const groupSel = `input[type="radio"][name="${CSS.escape(el.name)}"]`;
        if (document.querySelector(groupSel + ":checked")) continue;
      }
      el.checked = true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      filled++;
      continue;
    }

    const kind = classify(el)
      || (el.tagName === "TEXTAREA" ? "lorem"
        : type === "number" ? "number"
        : "word");
    let val;
    if (kind === "number") {
      const min = parseFloat(el.min);
      const max = parseFloat(el.max);
      const lo = isFinite(min) ? min : 1;
      const hi = isFinite(max) ? max : 100;
      val = String(Math.floor(lo + Math.random() * Math.max(1, hi - lo)));
    } else {
      val = (fakers[kind] || fakers.word)();
    }
    if (el.maxLength > 0 && val.length > el.maxLength) val = val.slice(0, el.maxLength);
    setValue(el, val);
    filled++;
  }
  return { filled };
}

document.getElementById("qbCalEvent").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    let selection = "";
    if (tab.id && tab.url && !/^chrome:\/\//.test(tab.url) && !/^chrome-extension:\/\//.test(tab.url)) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => (window.getSelection() ? window.getSelection().toString().trim() : ""),
        });
        selection = (res && res[0] && res[0].result) || "";
      } catch (_) {}
    }
    const params = new URLSearchParams();
    if (selection) params.set("text", selection.slice(0, 1024));
    const details = [tab.title, tab.url].filter(Boolean).join("\n");
    if (details) params.set("details", details.slice(0, 4096));
    await chrome.tabs.create({
      url: "https://calendar.google.com/calendar/u/0/r/eventedit?" + params.toString(),
    });
    flashButton(btn);
  } catch (err) {
    setQuickStatus(err.message || "Failed", "err");
  }
});

document.getElementById("qbCalToday").addEventListener("click", async (e) => {
  try {
    await chrome.tabs.create({ url: "https://calendar.google.com/calendar/u/0/r/day" });
    flashButton(e.currentTarget);
  } catch (err) {
    setQuickStatus(err.message || "Failed", "err");
  }
});

// ═══════════════════════════════════
//  Localhost Port Jumper
// ═══════════════════════════════════
const localhostListEl = document.getElementById("localhostList");
document.getElementById("lhRefresh").addEventListener("click", () => loadLocalhost());

async function loadLocalhost() {
  localhostListEl.innerHTML = '<div class="empty">Loading...</div>';
  try {
    if (!chrome.history || !chrome.history.search) {
      localhostListEl.innerHTML = '<div class="empty">History API unavailable</div>';
      return;
    }
    const since = Date.now() - 30 * 86400 * 1000;
    const results = await chrome.history.search({
      text: "localhost",
      maxResults: 1000,
      startTime: since,
    });
    // Also pull 127.0.0.1 since chrome.history.search is substring-based
    const results2 = await chrome.history.search({
      text: "127.0.0.1",
      maxResults: 500,
      startTime: since,
    });

    const grouped = new Map();
    function ingest(item) {
      try {
        const u = new URL(item.url);
        if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return;
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        const path = (u.pathname && u.pathname !== "/") ? u.pathname + (u.search || "") : (u.search || "");
        const key = `${u.protocol}//${u.hostname}:${port}${path}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.count += (item.visitCount || 1);
          if ((item.lastVisitTime || 0) > existing.lastVisit) {
            existing.lastVisit = item.lastVisitTime || existing.lastVisit;
            existing.title = item.title || existing.title;
          }
        } else {
          grouped.set(key, {
            url: item.url,
            host: u.hostname,
            port,
            path: path || "/",
            protocol: u.protocol.replace(":", ""),
            title: item.title || "",
            lastVisit: item.lastVisitTime || 0,
            count: item.visitCount || 1,
          });
        }
      } catch (_) {}
    }
    for (const r of results) ingest(r);
    for (const r of results2) ingest(r);

    const sorted = Array.from(grouped.values())
      .sort((a, b) => b.lastVisit - a.lastVisit)
      .slice(0, 30);

    if (!sorted.length) {
      localhostListEl.innerHTML = '<div class="empty">No recent localhost visits</div>';
      return;
    }

    localhostListEl.innerHTML = sorted.map((it) => `
      <a class="localhost-item" href="${escA(it.url)}" data-url="${escA(it.url)}" title="${escA(it.url)}">
        <span class="lh-protocol${it.protocol === "https" ? " https" : ""}">${esc(it.protocol)}</span>
        <span class="lh-port">:${esc(it.port)}</span>
        <span class="lh-path">${esc(it.path)}</span>
        <span class="lh-time">${timeAgo(it.lastVisit)}</span>
      </a>
    `).join("");

    localhostListEl.querySelectorAll(".localhost-item").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: a.dataset.url });
      });
    });
  } catch (err) {
    localhostListEl.innerHTML = `<div class="empty">${esc(err.message || "Failed to load")}</div>`;
  }
}

// ═══════════════════════════════════
//  Helpers
// ═══════════════════════════════════
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function escA(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
