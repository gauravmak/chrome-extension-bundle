# CLAUDE.md

Personal Chrome MV3 extension. Single user, forked, not auto-pulled.

## Security — strict, no exceptions

This extension holds `<all_urls>` + cookies + history + bookmarks + scripting. **One XSS in an extension page = full credential theft of every site I touch.** Dangerous patterns (eval, `new Function`, string `setTimeout`/`setInterval`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `document.write`, `executeScript({code})`, remote `<script src>`) are enforced by `scripts/check-security.mjs` on every Stop hook. Residual rules that can't be statically enforced:

- **Every page-originated value is untrusted** (page titles, URLs, DOM text, selection, parsed JSON, cookies, history, bookmarks, message payloads).
- **Scheme-allowlist any URL** from a page before `chrome.tabs.create` / `window.open` / anchor `href`. Allow `http(s):` only.
- **Validate message shape** before dispatching `onMessage` handlers to a privileged API.

## Non-obvious

- **Content scripts run in hostile DOM.** Namespace injected elements with `sl-`; namespace storage keys with the feature name (`nfe_*`, `darkmode_*`).
- **New manifest permissions need Remove + Reload, not just Reload.** Surface this at runtime when an API comes back `undefined` (see `popup.js` for missing `chrome.bookmarks`).
- **Bug → gate.** When a static check could have caught a bug, copy the shape of `scripts/check-instrumentation.mjs` or `scripts/check-security.mjs` and wire into the Stop hook. This rule itself can't be enforced — that's why it's here.

Behavioral rules (git etiquette, ratchet pattern, premature-gate caution) live in `~/.claude/projects/-home-artisan-code-chrome-extension-bundle/memory/`.
