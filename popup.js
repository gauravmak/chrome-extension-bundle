// ═══════════════════════════════════
//  Logger aliases — keeps every handler concise.
//  See logger.js for the underlying implementation.
// ═══════════════════════════════════
const log      = (action, data) => SL.log.action("popup", action, data);
const logInfo  = (action, data) => SL.log.info("popup", action, data);
const logWarn  = (action, data) => SL.log.warn("popup", action, data);
const logError = (action, data) => SL.log.error("popup", action, data);
const notify   = (msg, kind)    => SL.notify(msg, kind);
const notifyOk = (msg)          => SL.notify(msg, "ok");
const notifyErr= (msg)          => SL.notify(msg, "err");

SL.log.info("popup", "boot");

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
  btn.addEventListener("click", () => {
    log("nav", { to: btn.dataset.page });
    notify(btn.textContent.trim(), "info");
    switchToPage(btn.dataset.page);
  });
});

// Restore last open tab
chrome.storage.local.get(["last_tab"], (data) => {
  if (data.last_tab) switchToPage(data.last_tab);
});

// ═══════════════════════════════════
//  Shared helpers
//  (Tab Cleaner was removed — user keeps only required tabs anyway.)
// ═══════════════════════════════════

// Shared helper — used by Localhost list to show relative timestamps.
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

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
    cookieListEl.innerHTML = '<div class="empty">Cannot read cookies from this page</div>'; // safe-html: literal HTML
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
    cookieListEl.innerHTML = '<div class="empty">No cookies for this site</div>'; // safe-html: literal HTML
    return;
  }
  // safe-html: every interpolation routed through esc()/escA()
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
      const item = row.closest(".cookie-item");
      item.classList.toggle("expanded");
      log("cookies.expand", { idx: item.dataset.idx, open: item.classList.contains("expanded") });
      // no-notify: pure UI state — user already sees the row expand
    });
  });

  // Show Advanced
  cookieListEl.querySelectorAll(".advanced-toggle").forEach((t) => {
    t.addEventListener("click", () => {
      const fields = cookieListEl.querySelector(`.advanced-fields[data-advf="${t.dataset.adv}"]`);
      fields.classList.toggle("show");
      t.textContent = fields.classList.contains("show") ? "Hide Advanced" : "Show Advanced";
      log("cookies.advanced", { idx: t.dataset.adv, show: fields.classList.contains("show") });
      // no-notify: pure UI state — fields show/hide is the visible feedback
    });
  });

  // Delete buttons
  cookieListEl.querySelectorAll("[data-delidx]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cookie = allCookies[parseInt(btn.dataset.delidx)];
      log("cookies.delete", { name: cookie && cookie.name });
      notify("Deleting cookie " + (cookie && cookie.name) + "…", "info");
      deleteCookie(cookie);
    });
  });

  // Save buttons
  cookieListEl.querySelectorAll("[data-saveidx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      log("cookies.save", { idx: btn.dataset.saveidx });
      notify("Saving cookie…", "info");
      saveCookie(parseInt(btn.dataset.saveidx));
    });
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
  log("cookies.deleteAll", { count: allCookies.length });
  if (!allCookies.length) { notify("No cookies to delete", "info"); return; }
  notify("Deleting " + allCookies.length + " cookies…", "info");
  try {
    for (const c of allCookies) {
      const protocol = c.secure ? "https" : "http";
      const url = `${protocol}://${c.domain.replace(/^\./, "")}${c.path}`;
      await chrome.cookies.remove({ url, name: c.name });
    }
    loadCookies();
    notifyOk("Deleted all cookies for " + currentDomain);
  } catch (err) {
    logError("cookies.deleteAll.fail", { error: err.message });
    notifyErr("Delete failed: " + err.message);
  }
});

// Refresh
document.getElementById("btnRefresh").addEventListener("click", () => {
  log("cookies.refresh");
  notify("Refreshing cookies…", "info");
  loadCookies();
});

// Export
document.getElementById("btnExport").addEventListener("click", () => {
  log("cookies.export", { count: allCookies.length });
  if (!allCookies.length) { notify("Nothing to export", "info"); return; }
  const data = JSON.stringify(allCookies, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cookies-${currentDomain}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  notifyOk("Exported " + allCookies.length + " cookies");
});

// Add Cookie Modal
const addModal = document.getElementById("addModal");
document.getElementById("btnAdd").addEventListener("click", () => {
  log("cookies.addOpen");
  document.getElementById("newDomain").value = currentDomain ? "." + currentDomain : "";
  document.getElementById("newPath").value = "/";
  document.getElementById("newName").value = "";
  document.getElementById("newValue").value = "";
  addModal.classList.add("show");
  notify("Add cookie", "info");
});
document.getElementById("modalCancel").addEventListener("click", () => {
  log("cookies.addCancel");
  addModal.classList.remove("show");
  notify("Cancelled", "info");
});
addModal.addEventListener("click", (e) => {
  if (e.target === addModal) {
    log("cookies.addDismiss");
    addModal.classList.remove("show");
    // no-notify: backdrop click just closes the modal — modal disappearing is the feedback
  }
});
document.getElementById("modalSave").addEventListener("click", async () => {
  const name = document.getElementById("newName").value.trim();
  log("cookies.addSave", { name });
  if (!name) { notify("Name is required", "err"); return; }
  const domain = document.getElementById("newDomain").value.trim();
  const path = document.getElementById("newPath").value.trim() || "/";
  const url = `https://${domain.replace(/^\./, "")}${path}`;
  try {
    await chrome.cookies.set({
      url,
      name,
      value: document.getElementById("newValue").value,
      domain,
      path,
    });
    addModal.classList.remove("show");
    loadCookies();
    notifyOk("Added cookie " + name);
  } catch (err) {
    logError("cookies.addSave.fail", { error: err.message });
    notifyErr("Add failed: " + err.message);
  }
});

// ═══════════════════════════════════
//  Redirect Tracer
// ═══════════════════════════════════
const redirectChainEl = document.getElementById("redirectChain");
let lastRedirectText = "";

async function loadRedirects() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    redirectChainEl.innerHTML = '<div class="redirect-empty"><div class="big-icon">🔀</div><p>No active tab</p></div>'; // safe-html: literal HTML
    return;
  }

  const data = await chrome.runtime.sendMessage({ type: "getRedirects", tabId: tab.id });
  const chain = data.chain || [];
  const finalUrl = data.finalUrl || tab.url;
  const finalStatus = data.finalStatus || 200;

  if (!chain.length) {
    // No redirects — just show the final URL
    redirectChainEl.innerHTML = renderStep(finalUrl, finalStatus, true, false); // safe-html: renderStep() escapes all interpolations via esc()
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

  redirectChainEl.innerHTML = html; // safe-html: html is concatenated renderStep() output, all interpolations esc()'d
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

document.getElementById("btnRedirectRefresh").addEventListener("click", () => {
  log("redirects.refresh");
  notify("Refreshing redirect chain…", "info");
  loadRedirects();
});

document.getElementById("btnRedirectCopy").addEventListener("click", async () => {
  log("redirects.copy", { length: lastRedirectText.length });
  if (!lastRedirectText) { notify("Nothing to copy", "info"); return; }
  try {
    await navigator.clipboard.writeText(lastRedirectText);
    const btn = document.getElementById("btnRedirectCopy");
    const orig = btn.querySelector("span").textContent;
    btn.querySelector("span").textContent = "Copied!";
    setTimeout(() => { btn.querySelector("span").textContent = orig; }, 1500);
    notifyOk("Redirect chain copied");
  } catch (err) {
    logError("redirects.copy.fail", { error: err.message });
    notifyErr("Copy failed: " + err.message);
  }
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
  log("darkmode.apply", { enabled, brightness, scope: darkScope, host: darkHost });
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
  const scopeLabel = darkScope === "global" ? "all sites" : darkHost;
  notify("Dark mode " + (enabled ? "ON" : "OFF") + " — " + scopeLabel, enabled ? "ok" : "info");
}

darkToggle.addEventListener("change", () => {
  log("darkmode.toggle", { checked: darkToggle.checked });
  applyDark();
  // no-notify: applyDark() emits its own notification with full scope info
});

darkBrightness.addEventListener("input", () => {
  darkBrightnessVal.textContent = darkBrightness.value + "%";
  logInfo("darkmode.brightness.slide", { value: darkBrightness.value });
});
darkBrightness.addEventListener("change", () => {
  log("darkmode.brightness", { value: darkBrightness.value });
  applyDark();
  // no-notify: applyDark() emits the notification
});

scopeSite.addEventListener("click", () => {
  log("darkmode.scope", { scope: "site" });
  darkScope = "site";
  scopeSite.classList.add("active");
  scopeGlobal.classList.remove("active");
  notify("Scope: this site only", "info");
});
scopeGlobal.addEventListener("click", () => {
  log("darkmode.scope", { scope: "global" });
  darkScope = "global";
  scopeGlobal.classList.add("active");
  scopeSite.classList.remove("active");
  notify("Scope: all sites", "info");
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
  log("nocookie.toggle", { enabled });
  updateNoCookieUI(enabled);
  await chrome.storage.local.set({ nocookie_enabled: enabled });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "nocookie_toggle", enabled }).catch(() => {});
  }
  notify("Cookie dismisser " + (enabled ? "ON" : "OFF"), enabled ? "ok" : "info");
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

// Live preview as user types. We deliberately skip a toast here — fires on every
// keystroke and would spam. Only debug-log.
livecssEditor.addEventListener("input", async () => {
  logInfo("livecss.input", { length: livecssEditor.value.length });
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
  log("livecss.save", { host: livecssHost, length: livecssEditor.value.length });
  try {
    const key = "livecss_" + livecssHost;
    await chrome.storage.local.set({ [key]: livecssEditor.value });
    livecssSave.textContent = "Saved!";
    setTimeout(() => { livecssSave.textContent = "Save"; }, 1500);
    notifyOk("CSS saved for " + livecssHost);
  } catch (err) {
    logError("livecss.save.fail", { error: err.message });
    notifyErr("Save failed: " + err.message);
  }
});

livecssClear.addEventListener("click", async () => {
  log("livecss.clear", { host: livecssHost });
  livecssEditor.value = "";
  const key = "livecss_" + livecssHost;
  await chrome.storage.local.remove(key);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "livecss_update", css: "" }).catch(() => {});
  }
  notifyOk("CSS cleared for " + livecssHost);
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
    log("focus." + s.elId, { enabled, storageKey: s.storageKey });
    await chrome.storage.local.set({ [s.storageKey]: enabled });
    let tabsFound = 0;
    try {
      const tabs = await chrome.tabs.query({ url: s.urlPatterns });
      tabsFound = tabs.length;
      for (const t of tabs) {
        const msg = { type: s.msgType, enabled };
        if (s.nfeSite) msg.site = s.nfeSite;
        chrome.tabs.sendMessage(t.id, msg).catch((e) => {
          logWarn("focus.sendMessage.fail", { tabId: t.id, error: e && e.message });
        });
      }
    } catch (err) {
      logError("focus.tabs.query.fail", { error: err.message });
    }
    const label = el.closest(".focus-row").querySelector(".focus-site").textContent;
    notify(label + " " + (enabled ? "ON" : "OFF") + (tabsFound ? ` (${tabsFound} tab${tabsFound > 1 ? "s" : ""})` : ""), enabled ? "ok" : "info");
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
  log("jstoggle", { host: jsHost, enabled });
  updateJsUI(enabled);

  if (!chrome.contentSettings || !chrome.contentSettings.javascript) {
    logError("jstoggle.unsupported");
    notifyErr("contentSettings API unavailable");
    return;
  }
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

  notify("JS " + (enabled ? "enabled" : "blocked") + " for " + jsHost + " — reloading…", enabled ? "ok" : "info");
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

pipBtn.addEventListener("click", () => {
  log("pip.click");
  enterPiP();
  // no-notify: enterPiP() emits notifications for its various outcomes
});

async function enterPiP() {
  pipStatus.textContent = "";
  pipStatus.className = "pip-status";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    pipStatus.textContent = "No active tab";
    pipStatus.className = "pip-status err";
    logError("pip.noTab");
    notifyErr("No active tab");
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({ type: "pip", tabId: tab.id });
    logInfo("pip.result", result);
    if (!result) {
      pipStatus.textContent = "Could not access page";
      pipStatus.className = "pip-status err";
      notifyErr("Could not access page");
    } else if (result.error) {
      pipStatus.textContent = result.error;
      pipStatus.className = "pip-status err";
      notifyErr(result.error);
    } else if (result.action === "entered") {
      pipStatus.textContent = "Video in Picture-in-Picture";
      pipStatus.className = "pip-status ok";
      pipBtn.classList.add("active");
      notifyOk("Entered Picture-in-Picture");
    } else if (result.action === "exited") {
      pipStatus.textContent = "Exited Picture-in-Picture";
      pipStatus.className = "pip-status ok";
      pipBtn.classList.remove("active");
      notifyOk("Exited Picture-in-Picture");
    }
  } catch (err) {
    pipStatus.textContent = err.message;
    pipStatus.className = "pip-status err";
    logError("pip.fail", { error: err.message });
    notifyErr(err.message);
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
  log("jsonformat.toggle", { enabled });
  updateJsonFormatUI(enabled);
  await chrome.storage.local.set({ jsonformat_enabled: enabled });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: "jsonformat_toggle", enabled }).catch(() => {});
  }
  notify("JSON formatter " + (enabled ? "ON" : "OFF"), enabled ? "ok" : "info");
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
  if (preferred) {
    logInfo("quick.reading.folderFound", { id: preferred.id, parent: preferred.parentId, location: "bookmarks-bar" });
    return preferred.id;
  }
  if (fallback) {
    logInfo("quick.reading.folderFound", { id: fallback.id, parent: fallback.parentId, location: "fallback" });
    return fallback.id;
  }
  // Create under the bookmarks bar (id "1")
  logInfo("quick.reading.folderCreating", { parentId: "1" });
  const created = await chrome.bookmarks.create({ parentId: "1", title: READING_FOLDER_NAME });
  logInfo("quick.reading.folderCreated", { id: created.id });
  return created.id;
}

document.getElementById("qbReading").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  log("quick.reading.click");
  try {
    // Permission diagnostic: chrome.bookmarks is undefined when the
    // `bookmarks` permission hasn't been granted. This happens when the
    // extension was loaded before the permission was added to manifest.json
    // and the user clicked "Reload" instead of removing + re-adding it.
    if (!chrome.bookmarks) {
      logError("quick.reading.permissionMissing");
      setQuickStatus("Bookmarks permission missing", "err");
      notifyErr("Bookmarks permission not granted — reload at chrome://extensions and reopen this popup");
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    logInfo("quick.reading.activeTab", { url: tab && tab.url, title: tab && tab.title });
    if (!tab || !tab.url) {
      setQuickStatus("No active tab", "err");
      notifyErr("No active tab");
      return;
    }
    if (/^chrome:\/\//.test(tab.url) || /^chrome-extension:\/\//.test(tab.url)) {
      setQuickStatus("Can't bookmark Chrome internal pages", "err");
      notifyErr("Can't bookmark Chrome internal pages");
      return;
    }
    const parentId = await findOrCreateReadingFolder();
    logInfo("quick.reading.folder", { parentId });
    // Avoid creating a duplicate if the same URL already lives in the folder.
    const existing = await chrome.bookmarks.search({ url: tab.url });
    const already = existing.find((b) => b.parentId === parentId);
    if (already) {
      setQuickStatus("Already saved", "ok");
      flashButton(btn);
      notify("Already in Reading Material", "info");
      return;
    }
    const created = await chrome.bookmarks.create({ parentId, title: tab.title || tab.url, url: tab.url });
    logInfo("quick.reading.created", { id: created.id, parentId: created.parentId });
    setQuickStatus("Saved to Reading Material", "ok");
    flashButton(btn);
    notifyOk("Saved to Reading Material");
  } catch (err) {
    logError("quick.reading.fail", { error: err.message, stack: err.stack });
    setQuickStatus(err.message || "Failed to save", "err");
    notifyErr("Save failed: " + (err.message || "unknown error"));
  }
});

document.getElementById("qbMarkdown").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  log("quick.markdown.click");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setQuickStatus("No active tab", "err");
      notifyErr("No active tab");
      return;
    }
    if (/^chrome:\/\//.test(tab.url || "") || /^chrome-extension:\/\//.test(tab.url || "")) {
      setQuickStatus("Can't read Chrome internal pages", "err");
      notifyErr("Can't read Chrome internal pages");
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractMarkdownFromPage,
    });
    const out = results && results[0] && results[0].result;
    logInfo("quick.markdown.result", { source: out && out.source, length: out && out.md && out.md.length });
    if (!out || !out.md) {
      setQuickStatus("Nothing to convert", "err");
      notifyErr("Nothing to convert");
      return;
    }
    await navigator.clipboard.writeText(out.md);
    const label = out.source === "selection" ? "Selection copied" : "Article copied";
    setQuickStatus(`${label} (${out.md.length} chars)`, "ok");
    flashButton(btn);
    notifyOk(`${label} as markdown — ${out.md.length} chars`);
  } catch (err) {
    logError("quick.markdown.fail", { error: err.message });
    setQuickStatus(err.message || "Failed", "err");
    notifyErr("Markdown copy failed: " + (err.message || "unknown"));
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
  log("quick.pickColor.click");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setQuickStatus("No active tab", "err");
      notifyErr("No active tab");
      return;
    }
    if (/^chrome:\/\//.test(tab.url || "") || /^chrome-extension:\/\//.test(tab.url || "")) {
      setQuickStatus("Can't pick on Chrome pages", "err");
      notifyErr("Can't pick on Chrome pages");
      return;
    }
    setQuickStatus("Click anywhere on the page…", "ok");
    notify("Click anywhere on the page…", "info");
    // Run in MAIN world: EyeDropper is a window-bound web API and is NOT
    // exposed in chrome.scripting's default ISOLATED world. Empirically the
    // isolated `window` object lacks the EyeDropper constructor even when the
    // browser supports it, so `typeof window.EyeDropper` came back undefined
    // and our "Chrome 95+" message fired on modern Chrome — wrong diagnosis.
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: pickColorInPage,
    });
    const r = res && res[0] && res[0].result;
    logInfo("quick.pickColor.result", r);
    if (r && r.hex) {
      setQuickStatus(`Picked ${r.hex} — copied`, "ok");
      flashButton(btn);
      notifyOk(`Picked ${r.hex} — copied`);
    } else if (r && r.error) {
      setQuickStatus(r.error, "err");
      notifyErr(r.error);
    }
  } catch (err) {
    logError("quick.pickColor.fail", { error: err.message });
    setQuickStatus(err.message || "Failed", "err");
    notifyErr("Pick color failed: " + (err.message || "unknown"));
  }
});

// Runs in page MAIN world. EyeDropper API requires Chrome 95+ AND a secure
// context AND user activation (the popup click propagates).
async function pickColorInPage() {
  if (typeof window.EyeDropper !== "function") {
    // Concrete diagnostic — return what we actually see in this page context.
    const m = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1];
    return {
      error: `EyeDropper not exposed in this page (Chrome ${m || "?"}, secure=${window.isSecureContext}, top=${window.top === window})`,
    };
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

// Fill Form: two-stage. First click previews (read-only DOM scan in the page),
// shows the planned fills in a modal, and only fills after the user clicks
// "Fill Now". Cancel / backdrop click discards.
let fillFormPendingTabId = null;
const fillModalEl = document.getElementById("fillFormModal");

document.getElementById("qbFillForm").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  log("quick.fillForm.preview.click");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setQuickStatus("No active tab", "err");
      notifyErr("No active tab");
      return;
    }
    if (/^chrome:\/\//.test(tab.url || "") || /^chrome-extension:\/\//.test(tab.url || "")) {
      setQuickStatus("Can't fill on Chrome pages", "err");
      notifyErr("Can't fill on Chrome pages");
      return;
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: previewFormFillsInPage,
    });
    // Aggregate plans across frames
    const plan = (res || []).flatMap((r) => (r && r.result && r.result.plan) ? r.result.plan : []);
    logInfo("quick.fillForm.preview.result", { fields: plan.length, frames: (res || []).length });
    if (!plan.length) {
      setQuickStatus("No fillable fields found", "err");
      notify("No fillable fields found", "info");
      return;
    }
    fillFormPendingTabId = tab.id;
    showFillFormModal(plan);
    flashButton(btn);
    notify(`Preview ready — ${plan.length} field${plan.length === 1 ? "" : "s"}`, "info");
  } catch (err) {
    logError("quick.fillForm.preview.fail", { error: err.message });
    setQuickStatus(err.message || "Failed", "err");
    notifyErr("Fill preview failed: " + (err.message || "unknown"));
  }
});

function showFillFormModal(plan) {
  document.getElementById("fillPreviewSummary").textContent =
    `Will fill ${plan.length} field${plan.length === 1 ? "" : "s"}. Random values are re-generated when you click Fill Now.`;
  // safe-html: every interpolation routed through esc()
  document.getElementById("fillPreviewList").innerHTML = plan.map((p) => `
    <div class="fill-preview-item">
      <span class="fp-label" title="${escA(p.label)}">${esc(p.label)}</span>
      <span class="fp-type">${esc(p.type)}</span>
      <span class="fp-arrow">→</span>
      <span class="fp-value">${esc(p.preview)}</span>
    </div>
  `).join("");
  fillModalEl.classList.add("show");
}

document.getElementById("fillCancel").addEventListener("click", () => {
  log("quick.fillForm.cancel");
  fillModalEl.classList.remove("show");
  fillFormPendingTabId = null;
  notify("Cancelled", "info");
});

fillModalEl.addEventListener("click", (e) => {
  if (e.target === fillModalEl) {
    log("quick.fillForm.dismiss");
    fillModalEl.classList.remove("show");
    fillFormPendingTabId = null;
    // no-notify: backdrop click just closes the modal — disappearing is the feedback
  }
});

document.getElementById("fillConfirm").addEventListener("click", async () => {
  log("quick.fillForm.confirm.click");
  fillModalEl.classList.remove("show");
  const tabId = fillFormPendingTabId;
  fillFormPendingTabId = null;
  if (tabId == null) {
    notifyErr("No pending fill — try again");
    return;
  }
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: fillFormsInPage,
    });
    const total = (res || []).reduce((acc, r) => acc + ((r && r.result && r.result.filled) || 0), 0);
    logInfo("quick.fillForm.confirm.result", { totalFilled: total, frames: (res || []).length });
    if (total > 0) {
      setQuickStatus(`Filled ${total} field${total === 1 ? "" : "s"}`, "ok");
      notifyOk(`Filled ${total} field${total === 1 ? "" : "s"}`);
    } else {
      setQuickStatus("No fields were filled", "err");
      notify("No fields were filled (DOM may have changed)", "info");
    }
  } catch (err) {
    logError("quick.fillForm.confirm.fail", { error: err.message });
    notifyErr("Fill failed: " + (err.message || "unknown"));
  }
});

// Runs in page context. Read-only DOM scan — returns the plan without mutating.
function previewFormFillsInPage() {
  function elLabel(el) {
    const raw = (
      el.getAttribute("aria-label")
      || el.placeholder
      || el.name
      || el.id
      || (el.labels && el.labels[0] && el.labels[0].textContent)
      || el.tagName.toLowerCase()
    );
    return String(raw || "").trim().replace(/\s+/g, " ").slice(0, 50);
  }
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
  const KIND_LABELS = {
    email: "random test email",
    phone: "random US phone",
    url: "https://example.com/…",
    password: "Test1234!",
    number: "random number",
    date: "today",
    time: "12:30",
    datetime: "today, 12:30",
    firstName: "random first name",
    lastName: "random last name",
    fullName: "random full name",
    address: "random street address",
    city: "random city",
    state: "random state code",
    zip: "random ZIP",
    country: "USA",
    company: "random company",
    lorem: "lorem ipsum",
    word: "random word",
  };

  const plan = [];
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (el.disabled || el.readOnly) continue;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "file", "image", "reset"].includes(type)) continue;
    if (!(el instanceof HTMLSelectElement) && el.offsetParent === null && type !== "radio" && type !== "checkbox") continue;

    let kind, preview;
    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.options).filter((o) => o.value && !o.disabled);
      if (!opts.length) continue;
      kind = "select";
      preview = `random option (${opts.length} available)`;
    } else if (type === "checkbox") {
      if (el.checked) continue;
      kind = "checkbox";
      preview = "check";
    } else if (type === "radio") {
      if (el.name && document.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`)) continue;
      kind = "radio";
      preview = "select first in group";
    } else {
      kind = classify(el) || (el.tagName === "TEXTAREA" ? "lorem" : type === "number" ? "number" : "word");
      preview = KIND_LABELS[kind] || kind;
    }
    plan.push({
      label: elLabel(el),
      type: el.tagName.toLowerCase() + (type ? `[${type}]` : ""),
      preview,
    });
  }
  return { plan };
}

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
  log("quick.calEvent.click");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      notifyErr("No active tab");
      return;
    }
    let selection = "";
    if (tab.id && tab.url && !/^chrome:\/\//.test(tab.url) && !/^chrome-extension:\/\//.test(tab.url)) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => (window.getSelection() ? window.getSelection().toString().trim() : ""),
        });
        selection = (res && res[0] && res[0].result) || "";
      } catch (err) {
        logWarn("quick.calEvent.selectionFail", { error: err.message });
      }
    }
    logInfo("quick.calEvent.selection", { length: selection.length, hasSelection: !!selection });
    const params = new URLSearchParams();
    if (selection) params.set("text", selection.slice(0, 1024));
    const details = [tab.title, tab.url].filter(Boolean).join("\n");
    if (details) params.set("details", details.slice(0, 4096));
    await chrome.tabs.create({
      url: "https://calendar.google.com/calendar/u/0/r/eventedit?" + params.toString(),
    });
    flashButton(btn);
    notifyOk(selection ? "Calendar event opened with selection" : "Calendar event opened");
  } catch (err) {
    logError("quick.calEvent.fail", { error: err.message });
    setQuickStatus(err.message || "Failed", "err");
    notifyErr("Calendar event failed: " + (err.message || "unknown"));
  }
});

// Keys we exclude from export — browsing data (closed_tabs) is privacy-sensitive
// even when the user initiates the export; internal sentinels (sl_*) should be
// regenerated locally, not transplanted.
function isExportableKey(k) {
  if (k === "closed_tabs") return false;
  if (k.startsWith("sl_")) return false;
  return true;
}

document.getElementById("qbExportSettings").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  log("quick.exportSettings.click");
  try {
    const all = await chrome.storage.local.get(null);
    const exportable = {};
    for (const [k, v] of Object.entries(all)) {
      if (isExportableKey(k)) exportable[k] = v;
    }
    const payload = {
      _superlevels_export: 1,
      _exported_at: new Date().toISOString(),
      _extension_version: chrome.runtime.getManifest().version,
      data: exportable,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `superlevels-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    logInfo("quick.exportSettings.done", { keys: Object.keys(exportable).length });
    flashButton(btn);
    notifyOk(`Exported ${Object.keys(exportable).length} settings`);
  } catch (err) {
    logError("quick.exportSettings.fail", { error: err.message });
    notifyErr("Export failed: " + (err.message || "unknown"));
  }
});

const importFile = document.getElementById("qbImportFile");
document.getElementById("qbImportSettings").addEventListener("click", (e) => {
  log("quick.importSettings.click");
  notify("Choose an exported JSON file…", "info");
  importFile.click();
  // no-notify: file picker triggers — notify already fired above
});

importFile.addEventListener("change", async (e) => {
  log("quick.importSettings.fileChosen", { name: e.target.files[0] && e.target.files[0].name });
  const file = e.target.files[0];
  if (!file) { notify("No file chosen", "info"); return; }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || parsed._superlevels_export !== 1 || typeof parsed.data !== "object") {
      throw new Error("Not a SuperLevels settings export (missing _superlevels_export marker).");
    }
    // Merge — never wipe keys that aren't in the import.
    const toSet = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (isExportableKey(k)) toSet[k] = v;
    }
    await chrome.storage.local.set(toSet);
    logInfo("quick.importSettings.applied", { keys: Object.keys(toSet).length, exportedAt: parsed._exported_at });
    notifyOk(`Imported ${Object.keys(toSet).length} settings (merged)`);
  } catch (err) {
    logError("quick.importSettings.fail", { error: err.message });
    notifyErr("Import failed: " + (err.message || "invalid file"));
  } finally {
    importFile.value = ""; // allow re-selecting the same file
  }
});

// ═══════════════════════════════════
//  Localhost Port Jumper
// ═══════════════════════════════════
const localhostListEl = document.getElementById("localhostList");
const lhSearchEl = document.getElementById("lhSearch");
const lhCountEl = document.getElementById("lhCount");

// Cache of the full localhost-grouped list. Filtering operates on this in
// memory — avoids re-querying chrome.history on every keystroke.
let localhostCache = [];

document.getElementById("lhRefresh").addEventListener("click", () => {
  log("localhost.refresh");
  notify("Refreshing localhost history…", "info");
  loadLocalhost();
});

lhSearchEl.addEventListener("input", () => {
  logInfo("localhost.filter", { query: lhSearchEl.value });
  renderLocalhostList(lhSearchEl.value);
});

async function loadLocalhost() {
  localhostListEl.innerHTML = '<div class="empty">Loading...</div>'; // safe-html: literal HTML
  lhCountEl.textContent = "";
  try {
    if (!chrome.history || !chrome.history.search) {
      localhostListEl.innerHTML = '<div class="empty">History API unavailable</div>'; // safe-html: literal HTML
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

    localhostCache = Array.from(grouped.values())
      .sort((a, b) => b.lastVisit - a.lastVisit)
      .slice(0, 60); // cache up to 60; usually 5–20 in practice

    renderLocalhostList(lhSearchEl.value);
  } catch (err) {
    localhostListEl.innerHTML = `<div class="empty">${esc(err.message || "Failed to load")}</div>`; // safe-html: err.message routed through esc()
  }
}

function renderLocalhostList(query) {
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? localhostCache.filter((it) =>
        (it.title || "").toLowerCase().includes(q)
        || it.port.toLowerCase().includes(q)
        || it.path.toLowerCase().includes(q))
    : localhostCache;

  if (!filtered.length) {
    if (!localhostCache.length) {
      localhostListEl.innerHTML = '<div class="empty">No recent localhost visits</div>'; // safe-html: literal HTML
      lhCountEl.textContent = "";
    } else {
      localhostListEl.innerHTML = '<div class="empty">No matches</div>'; // safe-html: literal HTML
      lhCountEl.textContent = `0 of ${localhostCache.length}`;
    }
    return;
  }

  lhCountEl.textContent = q
    ? `${filtered.length} of ${localhostCache.length}`
    : `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}`;

  // safe-html: every interpolation routed through esc()/escA()
  localhostListEl.innerHTML = filtered.map((it) => `
    <a class="localhost-item" href="${escA(it.url)}" data-url="${escA(it.url)}" title="${escA(it.url)}">
      <span class="lh-port">:${esc(it.port)}</span>
      <div class="lh-info">
        <div class="lh-title${it.title ? "" : " empty"}">${esc(it.title || "(no title)")}</div>
        <div class="lh-path-row">
          <span class="lh-protocol${it.protocol === "https" ? " https" : ""}">${esc(it.protocol)}</span>
          <span class="lh-path">${esc(it.path)}</span>
        </div>
      </div>
      <span class="lh-time">${timeAgo(it.lastVisit)}</span>
    </a>
  `).join("");

  localhostListEl.querySelectorAll(".localhost-item").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      log("localhost.open", { url: a.dataset.url });
      notify("Opening " + a.dataset.url, "info");
      chrome.tabs.create({ url: a.dataset.url });
    });
  });
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
