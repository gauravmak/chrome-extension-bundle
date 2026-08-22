// ═══════════════════════════════════
//  WhatsApp send queue — content script (web.whatsapp.com)
//
//  Fully inert until the background queue driver messages it. Two request
//  shapes, plus a liveness probe:
//
//    wasend.send       (v1) one send attempt on the chat WhatsApp already
//                      opened via the /send deep link — the phone and the
//                      prefilled text live in the URL, this path never types
//                      and never navigates. Still the fallback path.
//    wasend.sendInApp  (v2) the app is ALREADY loaded: search the chat list
//                      for the phone number, open the one matching chat, type
//                      the text, send. No page load, no navigation.
//    wasend.ping       read-only probe: is the app rendered / logged out?
//
//  The SAFETY GATE is the point of this file: before clicking anything we
//  compare the composer's own text against the exact text the background
//  validated. If WhatsApp changes its DOM — or the deep link landed on the
//  wrong chat, or the draft was left over from a previous send — the text
//  won't match and we click NOTHING. A UI change fails safe instead of
//  sending the wrong message to the wrong person.
//
//  The AMBIGUITY RULE is the v2 counterpart of that gate: the in-app path
//  proceeds only when the chat-list search returns EXACTLY ONE candidate row.
//  Zero, two, or an unreadable results pane → clear the search, touch nothing,
//  and tell the background to fall back to the deep link (which carries the
//  phone number in the URL and cannot pick the wrong recipient). We never
//  guess which of several results the user meant.
//
//  Host DOM is hostile: read only what's needed, never innerHTML, never
//  navigate, never trust a selector to still exist next frame.
// ═══════════════════════════════════
(function () {
  const MODULE = "wasend";

  const COMPOSER_DEADLINE_MS = 45000; // wait for the chat composer to appear
  const CLEAR_DEADLINE_MS = 8000;     // wait for the composer to empty after click
  const POLL_MS = 500;                // MutationObserver fallback tick
  const LOGGED_OUT_GRACE_MS = 3000;   // don't call "not-logged-in" during boot

  // ── v2 (in-app chat switching) ──
  const SEARCH_DEADLINE_MS = 8000;    // wait for chat-list search results
  const SEARCH_STABLE_MS = 800;       // result count must hold still this long
  const SEARCH_POLL_MS = 200;
  const CHAT_PANEL_DEADLINE_MS = 8000; // conversation panel after a row click
  const CHAT_OPEN_DEADLINE_MS = 15000; // composer after the panel is open
  const UI_SETTLE_MS = 250;           // let the Escape / clear land
  const STAGE_PROBE_MS = 2500;        // per-stage wait in the click ladder
  const RETYPE_WAIT_MS = 1500;        // grace before the native-setter retype

  let busy = false; // one send at a time — the driver is sequential anyway

  // ── Small DOM helpers ──────────────────────────────────────────────
  function norm(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  // The search box and the chat composer share the same selector shape, and
  // the search box comes FIRST in DOM order. Prefer a candidate inside the
  // chat footer; otherwise take the last one.
  function findComposer() {
    let nodes;
    try {
      nodes = document.querySelectorAll('div[contenteditable="true"][data-tab]');
    } catch (_) {
      return null;
    }
    if (!nodes || !nodes.length) return null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      try {
        if (el.closest && el.closest("footer")) return el;
      } catch (_) { /* ignore — keep scanning */ }
    }
    return nodes[nodes.length - 1];
  }

  // ── v2 DOM anchors ─────────────────────────────────────────────────
  // Footer-anchored composer ONLY — no last-resort fallback. The in-app path
  // must have this: findComposer()'s fallback returns the last contenteditable
  // on the page, which on the chat-list screen IS the search box. Waiting on
  // that would mean typing the message into the search field. Here "no footer,
  // no composer" is the right answer — the caller falls back to the deep link.
  function findComposerInFooter() {
    let nodes;
    try {
      nodes = document.querySelectorAll('div[contenteditable="true"][data-tab]');
    } catch (_) {
      return null;
    }
    if (!nodes || !nodes.length) return null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      try {
        if (nodes[i].closest && nodes[i].closest("footer")) return nodes[i];
      } catch (_) { /* ignore — keep scanning */ }
    }
    return null;
  }

  // Both shapes are covered: WhatsApp has shipped the chat search as a
  // contenteditable div and, in newer builds, as a plain text input.
  const SEARCH_FIELD_SELECTOR =
    'div[contenteditable="true"], input[type="text"], input[type="search"]';

  // Current text of a search box / composer, whichever shape it is.
  function boxText(el) {
    try {
      if (!el) return "";
      if (el.tagName === "INPUT") return norm(el.value);
      return norm(el.textContent);
    } catch (_) {
      return "";
    }
  }

  // Exception text, safe to log: an Error's message never contains page data
  // we put there, and this is the difference between "internal-error" and a
  // named bug.
  function errText(err) {
    let s = "";
    try {
      s = (err && err.message) ? String(err.message) : String(err);
    } catch (_) {
      s = "unstringifiable";
    }
    return s.slice(0, 140);
  }

  // Stable non-reversible fingerprint. Lets diagnostics say "these two rows
  // are the same chat" without ever shipping a name off the page.
  function hash8(s) {
    let h = 5381;
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  // Every selector lookup below reports WHICH variant matched. Modern WhatsApp
  // Web has dropped most data-testid attributes, so each list is
  // testid-first-then-structural and the winning variant is logged — a lookup
  // that silently degrades to its last resort is the bug we could not see.
  function firstMatch(root, variants) {
    for (let i = 0; i < variants.length; i++) {
      try {
        const el = root.querySelector(variants[i][1]);
        if (el) return { el, via: variants[i][0] };
      } catch (_) { /* bad selector for this engine — try the next */ }
    }
    return { el: null, via: "none" };
  }

  // The chat-list SEARCH box. WhatsApp has historically used data-tab="3" for
  // search and a higher data-tab for the composer, but those values drift
  // between releases, so anchor on STRUCTURE instead: the composer is the
  // contenteditable inside the chat <footer> (v1's findComposer), the search
  // box is a field in the left pane / search region that is NOT in a footer.
  // Note this must not reuse findComposer() as an exclusion — on the chat-list
  // screen (no chat open) findComposer's last-resort branch returns the search
  // box itself.
  //
  // Returns { el, via, total, outside } — the counts are what tells us, from
  // the service worker log alone, whether the page had no editable field at
  // all or several we picked wrong from.
  function findSearchBoxEx() {
    let nodes;
    try {
      nodes = document.querySelectorAll(SEARCH_FIELD_SELECTOR);
    } catch (_) {
      return { el: null, via: "query-failed", total: 0, outside: 0, all: [] };
    }
    const total = nodes ? nodes.length : 0;
    if (!total) return { el: null, via: "no-fields", total: 0, outside: 0, all: [] };
    const outside = [];
    let preferred = null;
    let preferredVia = "";
    for (let i = 0; i < total; i++) {
      const el = nodes[i];
      try {
        if (el.closest && el.closest("footer")) continue; // that's the composer
      } catch (_) {
        continue;
      }
      outside.push(el);
      if (preferred) continue;
      const anchors = [
        ["side", "#side"],
        ["role-search", '[role="search"]'],
        ["testid-chat-list-search", '[data-testid="chat-list-search-container"]'],
        ["testid-search", '[data-testid="search-container"]'],
        ["aria-search", '[aria-label*="search" i]'],
      ];
      for (let a = 0; a < anchors.length; a++) {
        try {
          if (el.closest && el.closest(anchors[a][1])) {
            preferred = el;
            preferredVia = anchors[a][0];
            break;
          }
        } catch (_) { /* keep scanning */ }
      }
    }
    if (preferred) {
      return { el: preferred, via: preferredVia, total, outside: outside.length, all: outside };
    }
    // Structural fallback: in DOM order the search box precedes the composer,
    // and the composer is already excluded above.
    if (outside.length) {
      return { el: outside[0], via: "first-non-footer", total, outside: outside.length, all: outside };
    }
    return { el: null, via: "all-in-footer", total, outside: 0, all: [] };
  }

  // Structural identity of one editable field — TAG and ATTRIBUTE NAMES, and
  // LENGTHS of the human-readable attributes. Never their values. With two
  // inputs on the page this is what says which one we picked and what the
  // other one was.
  function describeField(el, picked) {
    const names = [];
    let where = "other";
    let tag = "";
    let aria = 0;
    let ph = 0;
    try {
      tag = String(el.tagName || "").toLowerCase();
      const attrs = el.attributes || [];
      for (let i = 0; i < attrs.length && i < 10; i++) names.push(attrs[i].name);
      aria = String((el.getAttribute && el.getAttribute("aria-label")) || "").length;
      ph = String((el.getAttribute && el.getAttribute("placeholder")) || "").length;
      if (el.closest) {
        if (el.closest("footer")) where = "footer";
        else if (el.closest("#pane-side")) where = "pane-side";
        else if (el.closest("#side")) where = "side";
        else if (el.closest("#main")) where = "main";
      }
    } catch (_) { /* best effort */ }
    return tag + "[" + names.join(",") + "] aria" + aria + " ph" + ph +
           " @" + where + (document.activeElement === el ? " focused" : "") +
           (picked ? " PICKED" : "");
  }

  // The pane the chat list / search results render into.
  function findResultsPaneEx() {
    return firstMatch(document, [
      ["pane-side", "#pane-side"],
      ["testid-chat-list", '[data-testid="chat-list"]'],
      ["aria-chat-list", '[aria-label][role="grid"]'],
      ["role-listbox", '[role="listbox"]'],
      ["side", "#side"],
    ]);
  }

  // ── The candidate-row classifier ───────────────────────────────────
  // v2.0 counted EVERY list item in the pane, which is why the in-app path
  // never fired: a WhatsApp search for a number renders section headers
  // ("Chats" / "Contacts" / "Messages") and often message-hit rows alongside
  // the contact, so `rows.length !== 1` was true on every single search.
  //
  // A real chat/contact row carries a named text element (a [title] attribute)
  // AND either an avatar image or a clickable affordance. Section headers have
  // no [title] and no avatar — they are short plain labels. Every row's
  // signals are logged so a wrong guess here is visible in the next run's
  // service-worker log instead of being invisible again.

  // The row's display name. WhatsApp puts it in a span[title]; the other
  // [title] attributes in a row are icon tooltips ("Muted"), which must never
  // be mistaken for the chat's identity — two different muted chats would look
  // like one. A real name is also rendered as visible text in the row, so
  // require that. Returns { value, visible }; the VALUE IS NEVER LOGGED.
  function pickTitle(el) {
    let first = "";
    try {
      const text = norm(el.textContent);
      const nodes = el.querySelectorAll("[title]");
      for (let i = 0; i < nodes.length; i++) {
        const v = norm(nodes[i].getAttribute("title") || "");
        if (!v) continue;
        if (!first) first = v;
        if (text.indexOf(v) !== -1) return { value: v, visible: true };
      }
    } catch (_) { /* fall through */ }
    return { value: first, visible: false };
  }

  // A SECTION HEADER row ("Chats" / "Contacts" / "Messages"): short plain
  // label, no title attribute, no avatar, nothing clickable. Every real chat
  // row has at least a name and an avatar, so this cannot swallow one.
  const HEADER_MAX_TEXT = 16;

  function classifyRow(el) {
    const info = { tag: "", role: "", ttl: 0, vis: 0, img: 0, btn: 0, txt: 0, hdr: 0, cand: false, id: "" };
    try {
      info.tag = String(el.tagName || "").toLowerCase();
      info.role = String((el.getAttribute && el.getAttribute("role")) || "");
      const title = pickTitle(el);
      info.ttl = title.value.length;
      info.vis = title.visible ? 1 : 0;
      info.img = el.querySelector('img, canvas, [data-icon*="user" i]') ? 1 : 0;
      info.btn = (el.querySelector('[role="button"], button') ||
                  (el.getAttribute && el.getAttribute("tabindex") !== null)) ? 1 : 0;
      const text = norm(el.textContent);
      info.txt = text.length;
      info.hdr = (info.ttl === 0 && info.img === 0 && info.btn === 0 &&
                  text.length >= 1 && text.length <= HEADER_MAX_TEXT) ? 1 : 0;
      info.cand = !info.hdr && title.visible && (info.img === 1 || info.btn === 1);
      // Identity = which CHAT this row points at. Rows in different sections
      // ("Contacts" and "Messages") that carry the same name open the same
      // chat, so they are one candidate, not two.
      info.id = info.cand ? hash8(title.value) : "t" + hash8(text.slice(0, 60));
    } catch (_) { /* leave as a non-candidate */ }
    return info;
  }

  // ── Section scoping ────────────────────────────────────────────────
  // WhatsApp renders search results as ordered sections — Chats, Contacts,
  // then Messages — separated by header rows. MESSAGE-section rows are chats
  // whose message TEXT contains the searched digits; they are structurally
  // identical to chat rows, so no per-row classifier and no identity dedupe
  // can tell them apart. Position is the only signal that can.
  //
  // So candidates are taken ONLY from the first result section: everything
  // after the first header and before the second. That is the direct
  // chat/contact match. With one header, everything after it; with none, the
  // whole list (an older layout — the exactly-one rule still guards it).
  //
  // This is also why the late-streaming message hits that broke the last run
  // are now harmless: they arrive in a later section.
  function sectionScope(rows) {
    const headers = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].info.hdr) headers.push(i);
    let start = 0;
    let end = rows.length;
    if (headers.length >= 2) { start = headers[0] + 1; end = headers[1]; }
    else if (headers.length === 1) { start = headers[0] + 1; }
    return { headers, start, end };
  }

  // Reads the results pane once. Returns null when the pane can't be found at
  // all (caller treats that as ambiguous), else:
  //   { via, rowsVia, raw, rows, headers, start, end, cands, ids }
  function scanResults() {
    const pane = findResultsPaneEx();
    if (!pane.el) return null;
    const rowSets = [
      ["listitem", '[role="listitem"]'],
      ["row", '[role="row"]'],
      ["option", '[role="option"]'],
      ["gridcell", '[role="gridcell"]'],
    ];
    let found = null;
    let rowsVia = "none";
    for (let i = 0; i < rowSets.length; i++) {
      try {
        const nodes = pane.el.querySelectorAll(rowSets[i][1]);
        if (nodes && nodes.length) { found = nodes; rowsVia = rowSets[i][0]; break; }
      } catch (_) { /* try the next shape */ }
    }
    const rows = [];
    if (found) {
      for (let i = 0; i < found.length; i++) {
        const el = found[i];
        try {
          if (!el || !el.isConnected) continue;
          if (norm(el.textContent) === "") continue; // spacer / placeholder
          rows.push({ el, info: classifyRow(el) });
        } catch (_) { /* skip this row */ }
      }
    }
    const scope = sectionScope(rows);
    const cands = [];
    const ids = [];
    for (let i = scope.start; i < scope.end && i < rows.length; i++) {
      const r = rows[i];
      if (!r.info.cand) continue;
      cands.push(r);
      if (ids.indexOf(r.info.id) === -1) ids.push(r.info.id);
    }
    return {
      via: pane.via, rowsVia, raw: rows.length, rows,
      headers: scope.headers, start: scope.start, end: scope.end,
      cands, ids,
    };
  }

  // Compact per-row structural breakdown for the log, one short string per
  // row: index:tag/role t<title len>v<title visible> i<avatar> b<clickable>
  // x<text len> h<section header> c<candidate> #<chat identity hash>.
  // Deliberately terse — the background caps the payload at ~500 chars.
  function rowBreakdown(scan) {
    const out = [];
    for (let i = 0; i < scan.rows.length && i < 10; i++) {
      const f = scan.rows[i].info;
      out.push(i + ":" + f.tag + "/" + (f.role || "-") +
               " t" + f.ttl + "v" + f.vis + " i" + f.img + " b" + f.btn + " x" + f.txt +
               " h" + f.hdr + " c" + (f.cand ? 1 : 0) + " #" + f.id);
    }
    return out;
  }

  // Best-effort display name of a result row — used only to confirm that the
  // chat which opened is the one we clicked.
  function rowTitle(row) {
    const t = pickTitle(row);
    return t.visible ? t.value.slice(0, 80) : "";
  }

  // The conversation panel — the right-hand side that appears once a chat is
  // open. Its presence is what separates "the click never opened a chat" from
  // "the chat opened but the composer selector is stale".
  function findChatPanelEx() {
    return firstMatch(document, [
      ["main-id", "#main"],
      ["role-main", '[role="main"]'],
      ["testid-conv-panel", '[data-testid="conversation-panel-wrapper"]'],
    ]);
  }

  // The conversation header, found WITHOUT depending on the panel selectors:
  // a <header> that is not inside the left pane. The run where #main and
  // [role=main] both came back "none" for a full 8s proved that panel
  // detection alone is too brittle to hang the open/not-open decision on.
  // Returns { el, via, weak }. `weak` marks a <header> we found only by
  // elimination — it is NOT trustworthy as "a chat is open".
  //
  // This distinction is load-bearing. A run reported chatWasOpen:1 from a
  // header while the ping on the same tab reported composer:0 — the two cannot
  // both be true, and the ping was right: what we had picked up was the app's
  // own top bar, not a conversation header. A stable non-conversation header
  // never changes, so it silently suppressed BOTH the "header changed" signal
  // and the composer fallback (which only runs when no header is readable),
  // and every click looked like it had failed. A real conversation header
  // carries the contact name in a [title] element, exactly like a chat row.
  function findChatHeaderEl() {
    try {
      const panel = findChatPanelEx();
      if (panel.el) {
        const h = panel.el.querySelector("header");
        if (h) return { el: h, via: "panel-header", weak: false };
      }
      const all = document.querySelectorAll("header");
      let firstOutside = null;
      for (let i = 0; i < all.length; i++) {
        const h = all[i];
        try {
          if (h.closest && (h.closest("#side") || h.closest("#pane-side"))) continue;
          if (!firstOutside) firstOutside = h;
          if (h.querySelector("[title]")) return { el: h, via: "titled-header", weak: false };
        } catch (_) { continue; }
      }
      if (firstOutside) return { el: firstOutside, via: "any-header", weak: true };
    } catch (_) { /* fall through */ }
    return { el: null, via: "none", weak: true };
  }

  // Diagnostics-grade view of the header: text (only when trustworthy), which
  // lookup produced it, and the length of even an untrusted one.
  function openChatHeaderInfo() {
    const found = findChatHeaderEl();
    let raw = "";
    if (found.el) {
      try { raw = norm(found.el.textContent).slice(0, 300); } catch (_) { raw = ""; }
    }
    return { text: found.weak ? "" : raw, via: found.via, weak: found.weak ? 1 : 0, rawLen: raw.length };
  }

  // Text of the open chat's header (contact name / number), "" if unreadable
  // or untrustworthy.
  function openChatHeaderText() {
    return openChatHeaderInfo().text;
  }

  // THE one matcher for "is this header showing the chat this row names".
  // Used by the pre-click check, the open probe and the final confirm, so the
  // three can never disagree the way they did when the probe said matched:0
  // and the confirm said match:1. Plain containment first; then a digits-only
  // comparison so a title like "+91 74057 25024" still matches a header that
  // renders it as "+917405725024".
  function headerMatchesTitle(header, title) {
    if (!header || !title) return false;
    if (header.indexOf(title) !== -1) return true;
    const t = title.replace(/[^0-9]/g, "");
    if (t.length >= 8) {
      const h = header.replace(/[^0-9]/g, "");
      if (h.indexOf(t) !== -1) return true;
    }
    return false;
  }

  // Snapshot of "which chat is on screen" taken before a click, so the probe
  // afterwards can tell that something actually changed.
  function chatSnapshot(box) {
    const comp = findComposerInFooter();
    return {
      header: openChatHeaderText(),
      composer: (comp && comp !== box) ? comp : null,
    };
  }

  // Has a chat opened since `before`? Header comparison is primary and now
  // works even when the panel selectors miss. The composer-appearing signal is
  // a guarded fallback for the build where no header is readable either: it
  // only counts when there was NO composer before, so the post-URL state
  // (a chat already open) can never satisfy it by standing still. The search
  // box can never satisfy it — findComposerInFooter is footer-anchored and the
  // box is excluded explicitly.
  function chatOpenSignal(title, before, box) {
    const panel = findChatPanelEx();
    const hdr = openChatHeaderText();
    if (hdr) {
      const changed = before.header === "" || hdr !== before.header;
      const matched = headerMatchesTitle(hdr, title);
      if (changed || matched) {
        return { ok: true, via: panel.el ? panel.via : "header-only", changed: changed ? 1 : 0, matched: matched ? 1 : 0 };
      }
      return null;
    }
    const comp = findComposerInFooter();
    if (comp && comp !== box && !before.composer) {
      return { ok: true, via: "composer-appeared", changed: 1, matched: 0 };
    }
    return null;
  }

  function waitForChatOpen(title, before, box, deadlineMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let iv = 0;
      function finish(v) {
        if (iv) clearInterval(iv);
        resolve(v);
      }
      function tick() {
        let sig = null;
        try { sig = chatOpenSignal(title, before, box); } catch (_) { sig = null; }
        if (sig) return finish({ ok: true, via: sig.via, changed: sig.changed, matched: sig.matched, ms: Date.now() - t0 });
        if (Date.now() - t0 > deadlineMs) {
          let via = "none";
          try { via = findChatPanelEx().via; } catch (_) { via = "none"; }
          return finish({ ok: false, via, changed: 0, matched: 0, ms: Date.now() - t0 });
        }
      }
      iv = setInterval(tick, 200);
      tick();
    });
  }

  // A bare .click() on a row with no button role does nothing — the run where
  // the tabindex descendant was clicked and no chat ever opened proved it.
  // React's row handlers want the whole pointer story, WITH real coordinates:
  // hit-testing code reads clientX/clientY and ignores events at (0,0).
  function pointerSequence(el) {
    let cx = 0;
    let cy = 0;
    try {
      const r = el.getBoundingClientRect();
      cx = Math.round(r.left + r.width / 2);
      cy = Math.round(r.top + r.height / 2);
    } catch (_) { cx = 0; cy = 0; }

    const steps = [
      ["pointerover", true, 0], ["pointerenter", true, 0], ["mousemove", false, 0],
      ["pointerdown", true, 1], ["mousedown", false, 1],
      ["pointerup", true, 0], ["mouseup", false, 0],
      ["click", false, 0],
    ];
    for (let i = 0; i < steps.length; i++) {
      const type = steps[i][0];
      const wantPointer = steps[i][1];
      const init = {
        bubbles: true, cancelable: true, composed: true,
        button: 0, buttons: steps[i][2], detail: 1,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy,
        pointerId: 1, pointerType: "mouse", isPrimary: true,
      };
      let ev = null;
      try {
        ev = (wantPointer && typeof PointerEvent === "function")
          ? new PointerEvent(type, init)
          : new MouseEvent(type, init);
      } catch (_) {
        ev = null;
      }
      if (!ev) continue;
      try { el.dispatchEvent(ev); } catch (_) { /* keep going — later steps may land */ }
    }
  }

  // Structural dump of everything that could be an editor near the chat —
  // TAG and ATTRIBUTE NAMES ONLY, never values, never text. This is what makes
  // a stale composer selector visible instead of just "no-composer".
  function editorRegionDump() {
    const out = [];
    const roots = [];
    const panel = findChatPanelEx();
    if (panel.el) roots.push(["main", panel.el]);
    try {
      const footers = document.querySelectorAll("footer");
      for (let i = 0; i < footers.length && i < 3; i++) roots.push(["footer" + i, footers[i]]);
    } catch (_) { /* no footers — that is itself the finding */ }
    for (let r = 0; r < roots.length; r++) {
      let nodes = null;
      try {
        nodes = roots[r][1].querySelectorAll('[contenteditable="true"], input, textarea, [role="textbox"]');
      } catch (_) {
        continue;
      }
      for (let i = 0; i < nodes.length && i < 5 && out.length < 10; i++) {
        const el = nodes[i];
        const names = [];
        try {
          const attrs = el.attributes || [];
          for (let a = 0; a < attrs.length && a < 8; a++) names.push(attrs[a].name);
        } catch (_) { /* names are best-effort */ }
        out.push(roots[r][0] + ":" + String(el.tagName || "").toLowerCase() + "[" + names.join(",") + "]");
      }
    }
    return out;
  }

  // Last-resort composer: a contenteditable inside the conversation panel that
  // is neither the search box nor anything in the left pane. Used only when
  // the footer-anchored lookup misses; the text gate still has to pass.
  function findComposerInMain(exclude) {
    const panel = findChatPanelEx();
    if (!panel.el) return null;
    let nodes = null;
    try {
      nodes = panel.el.querySelectorAll('div[contenteditable="true"], [contenteditable="true"][role="textbox"]');
    } catch (_) {
      return null;
    }
    if (!nodes || !nodes.length) return null;
    // The composer sits at the bottom of the panel — scan from the end.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      if (el === exclude) continue;
      try {
        if (el.closest && (el.closest("#side") || el.closest("#pane-side"))) continue;
      } catch (_) { continue; }
      return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  // ── Diagnostics that survive navigation ────────────────────────────
  // When the in-app attempt gives up, the background falls back to the deep
  // link — which navigates this tab and destroys the page console along with
  // every log written here. So each decision point is ALSO fired at the
  // service worker, whose console persists across those navigations.
  //
  // STRUCTURAL DATA ONLY: selector variant names, booleans, element counts,
  // row counts, pane fingerprints, tag/attribute names, string LENGTHS and
  // hashes. Never message text, never a chat title, never row text.
  const DIAG_MAX = 40; // per attempt — a runaway loop can't flood the log

  function makeDiag(nonce) {
    let sent = 0;
    const summary = [];
    return {
      // One decision point. Mirrored to the page console for live watching.
      emit(event, data) {
        const payload = (data && typeof data === "object") ? data : {};
        SL.log.info(MODULE, "cs." + event, payload);
        if (sent++ >= DIAG_MAX) return;
        try {
          const p = chrome.runtime.sendMessage({ type: "wasend.log", nonce, event, data: payload });
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) { /* worker asleep / context gone — diagnostics are best-effort */ }
      },
      // Short key=value crumbs that ride back on the reply, so the fallback
      // line in the service worker shows reason AND context together.
      note(key, value) {
        summary.push(key + "=" + String(value == null ? "" : value).slice(0, 24));
      },
      summary() {
        return summary.join(" ").slice(0, 200);
      },
    };
  }

  // keyCode/which aren't part of KeyboardEventInit; some handlers still read
  // them, so define them on the instance.
  function keyEvent(type, key, code, num) {
    const ev = new KeyboardEvent(type, {
      key, code, bubbles: true, cancelable: true, composed: true,
    });
    try {
      Object.defineProperty(ev, "keyCode", { get: () => num });
      Object.defineProperty(ev, "which", { get: () => num });
    } catch (_) { /* non-fatal — key/code are the ones that matter */ }
    return ev;
  }

  function pressEscape(target) {
    try {
      const t = (target && target.isConnected) ? target : document.body;
      if (t) t.dispatchEvent(keyEvent("keydown", "Escape", "Escape", 27));
    } catch (_) { /* ignore */ }
  }

  // WhatsApp's composer and search box are React-controlled contenteditables:
  // assigning textContent is ignored because React never sees an input event
  // it trusts. execCommand is deprecated-but-working and is the reliable way
  // to feed them — it produces the same events a real keystroke would.
  function typeInto(el, text) {
    try {
      if (!el || !el.isConnected) return false;
      el.focus();
      document.execCommand("selectAll", false, null);
      if (document.execCommand("insertText", false, text) === false) return false;
    } catch (_) {
      return false;
    }
    return boxText(el) !== "";
  }

  // The canonical way to drive a React-controlled field. execCommand can set
  // an <input>'s value without React's onChange ever firing — the run where
  // the box read back all 12 digits while the chat list never filtered was
  // exactly that. Writing through the NATIVE value setter bypasses React's
  // patched property, and the InputEvent that follows is what React listens
  // for, so its state finally catches up with the DOM.
  function nativeSetValue(el, text) {
    try {
      if (!el || !el.isConnected) return false;
      el.focus();
      const proto = (el.tagName === "INPUT") ? HTMLInputElement.prototype
        : (el.tagName === "TEXTAREA") ? HTMLTextAreaElement.prototype : null;
      if (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (!desc || typeof desc.set !== "function") return false;
        desc.set.call(el, text);
      } else {
        // contenteditable: no value property to drive — replace the text and
        // let the same input event tell React about it.
        el.textContent = text;
      }
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: false, composed: true,
        data: text, inputType: "insertText",
      }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {
      return false;
    }
    return boxText(el) !== "";
  }

  // Put the caret in a contenteditable and select everything already in it, so
  // the next insertion REPLACES rather than appends.
  function selectAllIn(el) {
    try {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (_) {
      return false;
    }
  }

  // The composer is a Lexical editor: execCommand("insertText") lands NOTHING
  // in it (a run showed accepted:0 len:0 against want:4). So the same
  // escalation idea used for the search field applies here, and each rung is
  // verified by reading the composer back:
  //   1. execCommand      — cheap, works on older builds
  //   2. beforeinput      — Lexical handles this natively
  //   3. synthetic paste  — the classic reliable route into WhatsApp
  // The exact-text gate downstream still has to pass whichever rung landed.
  async function typeIntoComposer(el, text, diag) {
    const attempts = [
      ["execCommand", () => {
        selectAllIn(el);
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
      }],
      ["beforeinput", () => {
        selectAllIn(el);
        el.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertText", data: text,
          bubbles: true, cancelable: true, composed: true,
        }));
        el.dispatchEvent(new InputEvent("input", {
          inputType: "insertText", data: text, bubbles: true, composed: true,
        }));
      }],
      ["paste", () => {
        selectAllIn(el);
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        el.dispatchEvent(new ClipboardEvent("paste", {
          clipboardData: dt, bubbles: true, cancelable: true, composed: true,
        }));
      }],
    ];

    for (let i = 0; i < attempts.length; i++) {
      const name = attempts[i][0];
      let threw = "";
      try {
        attempts[i][1]();
      } catch (err) {
        threw = errText(err);
      }
      await sleep(150); // let the editor render before reading it back
      const got = norm(el.textContent);
      if (diag) {
        diag.emit("compose.retype", {
          method: name, accepted: got !== "" ? 1 : 0, len: got.length,
          want: norm(text).length, error: threw,
        });
      }
      if (got !== "") return { ok: true, method: name, len: got.length };
    }
    return { ok: false, method: "none", len: 0 };
  }

  function clearBox(el) {
    try {
      if (!el || !el.isConnected) return;
      if (boxText(el) === "") return;
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (_) { /* ignore */ }
  }

  // What the app looks like right now — the answer to wasend.ping — plus the
  // structural evidence behind it, so a run that stalls on "loading" can be
  // diagnosed from the service-worker log alone. Checking for rendered app
  // chrome FIRST matters: on the chat-list screen there is no composer, and
  // looksLoggedOut()'s canvas heuristics could misfire.
  function appStateEx() {
    const sb = findSearchBoxEx();
    const composer = findComposerInFooter();
    const detail = {
      sb: sb.via, fields: sb.total, outside: sb.outside,
      composer: composer ? 1 : 0,
    };
    if (sb.el || findComposer()) return { state: "ready", detail };
    let out = false;
    try { out = looksLoggedOut(); } catch (_) { out = false; }
    detail.qr = out ? 1 : 0;
    return { state: out ? "logged-out" : "loading", detail };
  }

  // Logged-out landing page: a QR canvas is on screen and no composer exists.
  function looksLoggedOut() {
    if (findComposer()) return false;
    try {
      if (document.querySelector('[data-testid="qrcode"]')) return true;
      if (document.querySelector("canvas[aria-label]")) return true;
      if (document.querySelector("div[data-ref] canvas")) return true;
    } catch (_) { /* fall through */ }
    return false;
  }

  function findSendControl() {
    try {
      const byTestId = document.querySelector('[data-testid="send"]');
      if (byTestId) return byTestId;
      const byLabel = document.querySelector('button[aria-label="Send"]');
      if (byLabel) return byLabel;
      const icon = document.querySelector('span[data-icon="send"]');
      if (icon) return (icon.closest && icon.closest("button")) || icon;
    } catch (_) { /* fall through */ }
    return null;
  }

  // Same chain as v1 plus the icon names modern WhatsApp ships
  // (data-icon="wds-ic-send-filled"), reporting which variant hit. A miss is
  // not fatal — the in-app path presses Enter instead.
  function findSendControlEx() {
    const direct = firstMatch(document, [
      ["testid-send", '[data-testid="send"]'],
      ["aria-send-exact", 'button[aria-label="Send"]'],
      ["aria-send-prefix", 'button[aria-label^="Send" i]'],
    ]);
    if (direct.el) return direct;
    const icon = firstMatch(document, [
      ["icon-send", 'span[data-icon="send"]'],
      ["icon-send-fuzzy", '[data-icon*="send" i]'],
    ]);
    if (icon.el) {
      let btn = null;
      try { btn = icon.el.closest && icon.el.closest("button"); } catch (_) { btn = null; }
      return { el: btn || icon.el, via: icon.via + (btn ? "-button" : "-icon") };
    }
    return { el: null, via: "none" };
  }

  // Resolves { ok:true, composer } or { ok:false, reason }. Never rejects.
  // deadlineMs defaults to the v1 budget (a full page load); the in-app path
  // passes a much shorter one because the chat is already rendered, plus
  // strict=true so only a real footer composer counts.
  function waitForComposer(deadlineMs, strict) {
    const limit = typeof deadlineMs === "number" ? deadlineMs : COMPOSER_DEADLINE_MS;
    return new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      let obs = null;
      let iv = 0;

      function finish(result) {
        if (settled) return;
        settled = true;
        try { if (obs) obs.disconnect(); } catch (_) {}
        if (iv) clearInterval(iv);
        resolve(result);
      }

      function check() {
        if (settled) return;
        const composer = strict ? findComposerInFooter() : findComposer();
        if (composer) return finish({ ok: true, composer });
        const waited = Date.now() - t0;
        if (waited > LOGGED_OUT_GRACE_MS && looksLoggedOut()) {
          return finish({ ok: false, reason: "not-logged-in" });
        }
        if (waited > limit) {
          return finish({ ok: false, reason: looksLoggedOut() ? "not-logged-in" : "no-composer" });
        }
      }

      try {
        obs = new MutationObserver(check);
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) { obs = null; }
      iv = setInterval(check, POLL_MS);
      check();
    });
  }

  // Resolves true once the composer is empty (or gone), false on deadline.
  function waitForClear(composer) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      let obs = null;
      let iv = 0;

      function finish(value) {
        if (settled) return;
        settled = true;
        try { if (obs) obs.disconnect(); } catch (_) {}
        if (iv) clearInterval(iv);
        resolve(value);
      }

      function check() {
        if (settled) return;
        // A detached composer means WhatsApp re-rendered the footer — treat
        // the current one as gone and re-read whatever is on screen now.
        const live = (composer && composer.isConnected) ? composer : findComposer();
        if (!live) return finish(true);
        if (norm(live.textContent) === "") return finish(true);
        if (Date.now() - t0 > CLEAR_DEADLINE_MS) return finish(false);
      }

      try {
        obs = new MutationObserver(check);
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      } catch (_) { obs = null; }
      iv = setInterval(check, 200);
      check();
    });
  }

  // ── The one send attempt ───────────────────────────────────────────
  async function runSend(expectText, diag) {
    const expect = norm(expectText);

    const found = await waitForComposer();
    if (!found.ok) {
      SL.log.warn(MODULE, "cs.composer.miss", { reason: found.reason });
      return { ok: false, reason: found.reason };
    }

    // ── CALIBRATION (diagnostic only, changes nothing here) ──
    // On this path the deep link has definitely opened a chat and the composer
    // proves it. So whatever the panel/header lookups report RIGHT NOW is
    // ground truth for this WhatsApp build: if they come back "none" here,
    // they are stale, and the in-app path's chat-open detection cannot trust
    // them either. That is why waitForChatOpen has a composer fallback.
    if (diag) {
      let via = "none";
      try { via = findChatPanelEx().via; } catch (_) { via = "none"; }
      diag.emit("calibrate.panel", {
        via,
        header: openChatHeaderText().length,
        footerComposer: findComposerInFooter() ? 1 : 0,
      });
    }

    // ── SAFETY GATE ──
    // Compare what WhatsApp actually put in the composer against what the
    // background validated. Anything but an exact (whitespace-normalized)
    // match means we do not understand the page — click nothing.
    const actual = norm(found.composer.textContent);
    if (actual !== expect) {
      SL.log.warn(MODULE, "cs.gate.mismatch", {
        expectChars: expect.length,
        actualChars: actual.length,
      });
      return { ok: false, reason: "text-mismatch" };
    }
    SL.log.info(MODULE, "cs.gate.pass", { chars: expect.length });

    const sendEl = findSendControl();
    if (!sendEl) {
      SL.log.warn(MODULE, "cs.send.notFound");
      return { ok: false, reason: "no-send-button" };
    }

    try {
      sendEl.click();
    } catch (err) {
      SL.log.error(MODULE, "cs.send.clickFail", { error: (err && err.message) || "unknown" });
      return { ok: false, reason: "click-failed" };
    }
    SL.log.action(MODULE, "cs.send.clicked", { chars: expect.length });

    const cleared = await waitForClear(found.composer);
    if (!cleared) {
      SL.log.warn(MODULE, "cs.send.noClear");
      return { ok: false, reason: "no-clear" };
    }
    SL.log.info(MODULE, "cs.send.confirmed");
    return { ok: true };
  }

  // ── v2: the in-app send attempt ────────────────────────────────────
  // Cheap fingerprint of the pane, used to tell "the list has actually
  // re-rendered for my query" apart from "the unfiltered chat list is still
  // sitting there". Counts and hashes only — no row text.
  function paneSignature(scan) {
    if (scan === null) return "none";
    return scan.raw + "/" + scan.cands.length + "/" + scan.ids.join(",");
  }

  // Did the list actually FILTER, as opposed to merely change? A search that
  // matches narrows 70 rows to 2. The run that settled on "71 rows, 44
  // candidates" had only gained a row — a spurious change that satisfied a
  // plain "differs from baseline" test and let an unfiltered list be judged.
  // Requiring strictly fewer rows than the pre-search list is the honest test.
  function paneFiltered(scan, baseRaw) {
    return !!scan && scan.raw < baseRaw;
  }

  // Resolves { scan, timedOut } — scan is null when the results pane itself
  // could not be read.
  //
  // Two conditions before an early answer: the pane must have actually
  // filtered (see above) and the fingerprint must then hold still for
  // SEARCH_STABLE_MS (otherwise a contact row about to be joined by message
  // hits would be mistaken for a settled result). Anything unresolved rides
  // the full deadline and is judged on the final read. Every fingerprint
  // change is reported.
  function waitForResults(baseline, baseRaw, diag) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let lastSig = "";
      let lastChange = Date.now();
      let changes = 0;
      let iv = 0;

      function finish(value) {
        if (iv) clearInterval(iv);
        resolve(value);
      }

      function tick() {
        const scan = scanResults();
        const sig = paneSignature(scan);
        if (sig !== lastSig) {
          lastSig = sig;
          lastChange = Date.now();
          changes++;
          if (changes <= 6) {
            diag.emit("search.pane.change", {
              n: changes, ms: Date.now() - t0, sig,
              raw: scan ? scan.raw : -1,
              cands: scan ? scan.cands.length : -1,
            });
          }
        }
        if (scan && scan.raw > 0 && paneFiltered(scan, baseRaw) &&
            Date.now() - lastChange >= SEARCH_STABLE_MS) {
          return finish({ scan, timedOut: false });
        }
        if (Date.now() - t0 > SEARCH_DEADLINE_MS) {
          return finish({ scan, timedOut: true });
        }
      }

      iv = setInterval(tick, SEARCH_POLL_MS);
      tick();
    });
  }

  // The app is already loaded. Switch to the chat for `phone` and send.
  // `state.attempted` flips the instant a send is triggered — after that point
  // we never report fallback:true, because a retry through the deep link could
  // double-send.
  async function runSendInApp(phone, expectText, state, diag) {
    const expect = norm(expectText);

    const sb = findSearchBoxEx();
    diag.emit("search.box", { via: sb.via, total: sb.total, outside: sb.outside, found: sb.el ? 1 : 0 });
    diag.note("sb", sb.via);
    if (!sb.el) {
      return { ok: false, reason: "no-search-box", fallback: true, diag: diag.summary() };
    }
    const box = sb.el;
    // With more than one editable field on the page, say exactly which one was
    // picked and what the others are — structure and lengths only.
    const inventory = [];
    for (let i = 0; i < sb.all.length && i < 4; i++) {
      inventory.push(describeField(sb.all[i], sb.all[i] === box));
    }
    diag.emit("search.box.shape", {
      tag: String(box.tagName || "").toLowerCase(),
      ce: box.getAttribute ? String(box.getAttribute("contenteditable") || "") : "",
      tab: box.getAttribute ? String(box.getAttribute("data-tab") || "") : "",
      role: box.getAttribute ? String(box.getAttribute("role") || "") : "",
      fields: inventory,
    });

    // Reset whatever the previous item left on screen. After a URL-mode send a
    // chat is open and the search may hold stale text, so Escape and the clear
    // do different work on different items — report which.
    const hadText = boxText(box) !== "";
    const chatBefore = openChatHeaderText() !== "";
    pressEscape(box);
    clearBox(box);
    await sleep(UI_SETTLE_MS);
    diag.emit("reset", {
      escapes: 1,
      searchCleared: hadText ? 1 : 0,
      chatWasOpen: chatBefore ? 1 : 0,
      chatStillOpen: openChatHeaderText() !== "" ? 1 : 0,
    });

    const before = scanResults();
    const baseline = paneSignature(before);
    const baseRaw = before ? before.raw : 0;
    diag.emit("search.baseline", {
      sig: baseline,
      paneVia: before ? before.via : "none",
      rowsVia: before ? before.rowsVia : "none",
      raw: baseRaw,
    });
    diag.note("pane", before ? before.via + ":" + before.rowsVia : "none");

    const typed = typeInto(box, phone);
    const echo = boxText(box);
    diag.emit("search.typed", {
      accepted: typed ? 1 : 0,
      len: echo.length,
      digits: echo.replace(/[^0-9]/g, "").length,
      want: phone.length,
      focused: document.activeElement === box ? 1 : 0,
    });
    // An editor that ignores execCommand leaves the box empty. Say so plainly
    // instead of letting it time out later as "search-timeout".
    if (!typed || echo.length === 0) {
      clearBox(box);
      diag.emit("search.type.fail", { len: echo.length, tag: String(box.tagName || "").toLowerCase() });
      return { ok: false, reason: "search-type-failed", fallback: true, diag: diag.summary() };
    }
    if (echo.replace(/[^0-9]/g, "").indexOf(phone) === -1) {
      clearBox(box);
      diag.emit("search.type.notEchoed", { len: echo.length, digits: echo.replace(/[^0-9]/g, "").length });
      return { ok: false, reason: "search-type-failed", fallback: true, diag: diag.summary() };
    }

    // The value is in the DOM — but React may never have heard about it. Give
    // the list a moment to filter; if it hasn't, drive the field through the
    // native setter so React's own state updates, then let the normal wait run.
    let retyped = 0;
    const settleUntil = Date.now() + RETYPE_WAIT_MS;
    while (Date.now() < settleUntil) {
      if (paneFiltered(scanResults(), baseRaw)) break;
      await sleep(SEARCH_POLL_MS);
    }
    if (!paneFiltered(scanResults(), baseRaw)) {
      const ok = nativeSetValue(box, phone);
      const echo2 = boxText(box);
      retyped = 1;
      diag.emit("search.retype", {
        method: "native-setter", accepted: ok ? 1 : 0, len: echo2.length,
        digits: echo2.replace(/[^0-9]/g, "").length,
      });
      diag.note("retype", ok ? "native" : "failed");
    }

    const res = await waitForResults(baseline, baseRaw, diag);
    const scan = res.scan;

    if (scan === null) {
      clearBox(box);
      diag.emit("search.pane.missing", { timedOut: res.timedOut ? 1 : 0 });
      diag.note("verdict", "no-pane");
      return { ok: false, reason: "no-results-pane", fallback: true, diag: diag.summary() };
    }

    diag.emit("search.rows", {
      paneVia: scan.via, rowsVia: scan.rowsVia,
      raw: scan.raw, baseRaw, filtered: paneFiltered(scan, baseRaw) ? 1 : 0, retyped,
      cands: scan.cands.length, ids: scan.ids.length,
      hdrs: scan.headers, scope: [scan.start, scan.end],
      timedOut: res.timedOut ? 1 : 0,
    });
    diag.emit("search.breakdown", { hdrs: scan.headers, scope: [scan.start, scan.end], rows: rowBreakdown(scan) });
    diag.note("raw", scan.raw);
    diag.note("sec", scan.start + "-" + scan.end);
    diag.note("cand", scan.cands.length);
    diag.note("ids", scan.ids.length);

    // The list never narrowed even after the native-setter retype: the field
    // accepts text that the app is not searching on. Distinct from "several
    // matches" — this is "the search never ran".
    if (!paneFiltered(scan, baseRaw)) {
      clearBox(box);
      diag.emit("search.notFiltering", { raw: scan.raw, baseRaw, retyped });
      diag.note("verdict", "not-filtering");
      return { ok: false, reason: "search-not-filtering", fallback: true, diag: diag.summary() };
    }

    // ── AMBIGUITY RULE ──
    // EXACTLY ONE chat may be opened, or we touch nothing. Rows are first
    // classified (section headers and other furniture are not candidates),
    // then candidates are deduplicated by chat identity — the same contact
    // listed under "Contacts" and again under "Messages" is one chat, not an
    // ambiguity. Two different chats, zero chats, or an unreadable pane hands
    // the item to the deep-link fallback, where the recipient comes from the
    // URL instead of a guess. The row-title vs chat-header cross-check below
    // is the backstop if this classification is ever wrong.
    if (scan.ids.length !== 1) {
      clearBox(box);
      const reason = (scan.cands.length === 0 && res.timedOut) ? "search-timeout" : "ambiguous-search";
      diag.emit("search.verdict", { verdict: reason, raw: scan.raw, cands: scan.cands.length, ids: scan.ids.length });
      diag.note("verdict", reason);
      return { ok: false, reason, fallback: true, diag: diag.summary() };
    }

    const pick = scan.cands[0];
    const row = pick.el;
    const title = rowTitle(row);
    diag.emit("search.verdict", {
      verdict: "unique", raw: scan.raw, cands: scan.cands.length,
      id: pick.info.id, titleLen: title.length,
    });
    diag.note("verdict", "unique");

    // If the target chat is already open — WhatsApp restores the last chat on
    // load, and consecutive items can hit the same contact — clicking its
    // search result is a visual no-op that the open-probe reads as a failure.
    // Same containment test as chat.confirm below; chat.pre records the raw
    // facts either way so an export settles what was on screen pre-click.
    const headerPre = openChatHeaderText();
    const alreadyOpen = !!(title && headerPre && headerPre.indexOf(title) !== -1);
    diag.emit("chat.pre", {
      headerLen: headerPre.length,
      headerHash: headerPre ? hash8(headerPre) : "",
      titleHash: title ? hash8(title) : "",
      contains: alreadyOpen ? 1 : 0,
    });

    // ── Row activation ladder ──
    // A bare .click() on the inner tabindex div did nothing for a full 8s in
    // the last run. Each stage below is a genuinely different way to activate
    // the row, and each is followed by its own short open-probe so we learn
    // WHICH one works rather than which combination did. Deliberately no plain
    // `button` variant among the targets: a <button> inside a result row is
    // more likely an overflow/menu control than the row itself.
    const inner = firstMatch(row, [
      ["testid-cell", '[data-testid="cell-frame-container"]'],
      ["role-button", '[role="button"]'],
      ["tabindex", "[tabindex]"],
    ]);
    // Structural dump of the row's clickable innards: one run's row exposed
    // only a bare [tabindex] where a working row had a cell-frame testid, so
    // record what this row actually offers. Attribute names only, capped.
    diag.emit("row.inner", {
      via: inner.el ? inner.via : "none",
      clickables: Array.prototype.slice.call(
        row.querySelectorAll('[role="button"], [tabindex], button, [data-testid]'), 0, 6
      ).map(function (el) {
        return String(el.tagName || "").toLowerCase() + "[" +
          Array.prototype.map.call(el.attributes || [], function (a) { return a.name; }).join(",") + "]";
      }),
    });
    const beforeChat = chatSnapshot(box);

    const stages = [];
    stages.push({ name: "pointer-inner", via: inner.el ? inner.via : "row", run: () => pointerSequence(inner.el || row) });
    if (inner.el) stages.push({ name: "pointer-row", via: "row", run: () => pointerSequence(row) });
    // Keyboard: WhatsApp opens the sole search result on Enter. Only ever
    // reached when the search matched EXACTLY ONE chat, so it cannot land on
    // someone else.
    stages.push({ name: "enter-key", via: "search-box", run: () => {
      try {
        box.focus();
        box.dispatchEvent(keyEvent("keydown", "Enter", "Enter", 13));
        box.dispatchEvent(keyEvent("keyup", "Enter", "Enter", 13));
      } catch (_) { /* probe will report the miss */ }
    } });

    let opened = alreadyOpen
      ? { ok: true, via: "already-open", changed: 0, matched: 1, ms: 0 }
      : null;
    for (let s = 0; !opened && s < stages.length; s++) {
      const stage = stages[s];
      try {
        stage.run();
      } catch (err) {
        diag.emit("row.click.stage", { stage: stage.name, via: stage.via, error: errText(err) });
        continue;
      }
      diag.emit("row.click.stage", { stage: stage.name, via: stage.via, n: s + 1 });
      const last = s === stages.length - 1;
      const probe = await waitForChatOpen(title, beforeChat, box, last ? CHAT_PANEL_DEADLINE_MS : STAGE_PROBE_MS);
      if (probe.ok) {
        opened = probe;
        diag.emit("row.click", { via: stage.via, stage: stage.name, ms: probe.ms });
        diag.note("click", stage.name);
        break;
      }
    }

    if (!opened) {
      diag.note("open", "no");
      diag.emit("chat.open", { ok: 0, via: "none", changed: 0, matched: 0, stages: stages.length });
      // Nothing was typed and nothing was sent — safe to hand to the deep link.
      return { ok: false, reason: "chat-not-open", fallback: true, diag: diag.summary() };
    }
    diag.emit("chat.open", {
      ok: 1, via: opened.via, changed: opened.changed,
      matched: opened.matched, ms: opened.ms,
    });
    diag.note("open", opened.via);

    const found = await waitForComposer(CHAT_OPEN_DEADLINE_MS, true);
    diag.emit("chat.composer", { ok: found.ok ? 1 : 0, reason: found.reason || "" });
    let composerEl = found.ok ? found.composer : null;

    // The chat is open but the footer-anchored composer is missing: dump the
    // structure so a stale selector is visible next run, then try a
    // panel-anchored contenteditable. The search box and the whole left pane
    // are excluded, and the text gate below still has to pass.
    if (!composerEl) {
      diag.emit("compose.region", { nodes: editorRegionDump() });
      const alt = findComposerInMain(box);
      diag.emit("compose.altAnchor", { found: alt ? 1 : 0, tag: alt ? String(alt.tagName || "").toLowerCase() : "" });
      if (alt) composerEl = alt;
    }
    if (!composerEl) {
      diag.note("composer", found.reason || "miss");
      return {
        ok: false,
        reason: found.reason || "no-composer",
        fallback: found.reason !== "not-logged-in",
        diag: diag.summary(),
      };
    }
    // Belt and braces: never, under any DOM drift, type the message into the
    // field we just searched in.
    if (composerEl === box) {
      diag.emit("chat.composer.isSearchBox");
      return { ok: false, reason: "no-composer", fallback: true, diag: diag.summary() };
    }

    // Confirm the chat that opened is the row we clicked — guards against the
    // results list re-rendering between the count and the click, and backstops
    // a mis-classification above. Lenient by design: only enforced when both
    // strings are actually readable.
    const header = openChatHeaderText();
    const matched = title && header ? (header.indexOf(title) !== -1) : null;
    diag.emit("chat.confirm", {
      titleLen: title.length, headerLen: header.length,
      titleHash: title ? hash8(title) : "",
      checked: matched === null ? 0 : 1, match: matched === true ? 1 : 0,
    });
    if (matched === false) {
      diag.note("chat", "mismatch");
      return { ok: false, reason: "chat-mismatch", fallback: true, diag: diag.summary() };
    }

    // Empty the search field now that the chat is open: WhatsApp does not
    // always clear it, and a leftover phone number is both a stale UI state
    // for the next item and a decoy for waitForClear's composer re-read.
    clearBox(box);

    // Clearing the search re-renders the left pane; re-resolve the composer in
    // case WhatsApp swapped the footer out from under us.
    const composer = (composerEl && composerEl.isConnected)
      ? composerEl : (findComposerInFooter() || findComposerInMain(box));
    diag.emit("compose.resolve", {
      reused: composer === composerEl ? 1 : 0,
      found: composer ? 1 : 0,
      tag: composer ? String(composer.tagName || "").toLowerCase() : "",
      tab: composer && composer.getAttribute ? String(composer.getAttribute("data-tab") || "") : "",
    });
    if (!composer || composer === box) {
      diag.note("composer", "lost");
      return { ok: false, reason: "no-composer", fallback: true, diag: diag.summary() };
    }

    // selectAll + each ladder rung replaces any leftover draft rather than
    // appending. Lexical ignores execCommand on some builds, so escalate:
    // execCommand → beforeinput → synthetic paste (compose.retype logs each).
    const wrote = await typeIntoComposer(composer, expectText, diag);
    const actual = norm(composer.textContent);
    diag.emit("compose.typed", {
      accepted: wrote.ok ? 1 : 0, len: actual.length, want: expect.length,
      method: wrote.method,
      focused: document.activeElement === composer ? 1 : 0,
    });
    if (!wrote.ok) {
      diag.note("compose", "type-failed");
      return { ok: false, reason: "compose-type-failed", fallback: true, diag: diag.summary() };
    }

    // ── SAFETY GATE (identical to v1) ──
    if (actual !== expect) {
      SL.log.warn(MODULE, "cs.gate.mismatch", {
        expectChars: expect.length,
        actualChars: actual.length,
      });
      diag.emit("gate", { pass: 0, want: expect.length, got: actual.length });
      diag.note("gate", "mismatch");
      // No fallback: our own text is sitting in this chat's composer, and a
      // deep-link retry on top of a stale draft is exactly what the gate is
      // there to distrust.
      return { ok: false, reason: "text-mismatch", diag: diag.summary() };
    }
    diag.emit("gate", { pass: 1, chars: expect.length });

    const send = findSendControlEx();
    diag.emit("send.control", { via: send.via, found: send.el ? 1 : 0 });
    diag.note("send", send.el ? send.via : "enter");
    state.attempted = true;
    try {
      if (send.el) send.el.click();
      else composer.dispatchEvent(keyEvent("keydown", "Enter", "Enter", 13));
    } catch (err) {
      diag.emit("send.fail", { error: (err && err.message) || "unknown" });
      return { ok: false, reason: "click-failed", diag: diag.summary() };
    }
    SL.log.action(MODULE, "cs.send.clicked", { chars: expect.length, via: send.el ? send.via : "enter" });

    const cleared = await waitForClear(composer);
    diag.emit("send.cleared", { cleared: cleared ? 1 : 0 });
    if (!cleared) {
      diag.note("clear", "no");
      return { ok: false, reason: "no-clear", diag: diag.summary() };
    }
    diag.note("clear", "yes");
    return { ok: true, diag: diag.summary() };
  }

  // ── Message entry point ────────────────────────────────────────────
  // Every field is validated before anything touches the page. Unknown
  // shapes are ignored outright (return undefined → no response channel).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "wasend.send") return;
    if (typeof msg.nonce !== "string" || !msg.nonce) return;
    if (typeof msg.expectText !== "string") return;
    // Only our own background/popup may drive this. Content scripts can't be
    // reached by other extensions without externally_connectable, but check
    // anyway — message payloads are untrusted (CLAUDE.md).
    if (!sender || sender.id !== chrome.runtime.id) return;

    const nonce = msg.nonce;
    if (busy) {
      sendResponse({ nonce, ok: false, reason: "busy" });
      return true;
    }
    busy = true;
    SL.log.info(MODULE, "cs.request", { chars: msg.expectText.length });

    const urlDiag = makeDiag(nonce);
    runSend(msg.expectText, urlDiag)
      .then((r) => sendResponse({ nonce, ok: r.ok === true, reason: r.reason || "" }))
      .catch((err) => {
        // Carry the real exception all the way to the service worker log: this
        // path ends in a navigation that destroys the page console, and a bare
        // "internal-error" once hid a ReferenceError for a whole test round.
        const detail = errText(err);
        SL.log.error(MODULE, "cs.error", { error: detail });
        try { makeDiag(nonce).emit("attempt.error", { path: "url", error: detail }); } catch (_) {}
        sendResponse({ nonce, ok: false, reason: "internal-error", diag: "err=" + detail });
      })
      .finally(() => { busy = false; });
    return true; // async sendResponse
  });

  // ── v2 message entry point ─────────────────────────────────────────
  // A separate listener so the v1 handler above stays exactly as tested.
  // Chrome delivers the message to both; each ignores what isn't its own.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "wasend.ping" && msg.type !== "wasend.sendInApp") return;
    if (typeof msg.nonce !== "string" || !msg.nonce) return;
    // Same rule as the v1 handler: only our own background may drive this.
    if (!sender || sender.id !== chrome.runtime.id) return;

    const nonce = msg.nonce;

    if (msg.type === "wasend.ping") {
      let probe = { state: "loading", detail: {} };
      try { probe = appStateEx(); } catch (_) { probe = { state: "loading", detail: {} }; }
      sendResponse({ nonce, ok: true, state: probe.state, detail: probe.detail });
      return true;
    }

    // wasend.sendInApp — re-validate every field before touching the page.
    if (typeof msg.phone !== "string" || !/^[0-9]{8,15}$/.test(msg.phone)) return;
    if (typeof msg.expectText !== "string" || !msg.expectText) return;

    if (busy) {
      sendResponse({ nonce, ok: false, reason: "busy", fallback: false });
      return true;
    }
    busy = true;
    const diag = makeDiag(nonce);
    diag.emit("attempt.start", { chars: msg.expectText.length, href: location.pathname });

    const state = { attempted: false };
    runSendInApp(msg.phone, msg.expectText, state, diag)
      .then((r) => {
        diag.emit("attempt.end", {
          ok: r.ok === true ? 1 : 0,
          reason: r.reason || "",
          fallback: r.ok !== true && r.fallback === true ? 1 : 0,
        });
        sendResponse({
          nonce,
          ok: r.ok === true,
          reason: r.reason || "",
          fallback: r.ok !== true && r.fallback === true,
          mode: "in-app",
          diag: String(r.diag || diag.summary()).slice(0, 200),
        });
      })
      .catch((err) => {
        const detail = errText(err);
        SL.log.error(MODULE, "cs.error", { error: detail });
        diag.emit("attempt.error", { path: "in-app", error: detail, attempted: state.attempted ? 1 : 0 });
        // Only offer the fallback if nothing was ever clicked.
        sendResponse({
          nonce, ok: false, reason: "internal-error",
          fallback: !state.attempted,
          diag: (diag.summary() + " err=" + detail).slice(0, 200),
        });
      })
      .finally(() => { busy = false; });
    return true; // async sendResponse
  });

  SL.log.info(MODULE, "cs.ready");
})();
