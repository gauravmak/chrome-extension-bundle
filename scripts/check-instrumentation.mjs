#!/usr/bin/env node
// ═══════════════════════════════════
//  Instrumentation linter for SuperLevels
//  Verifies every user-facing event handler in the extension has:
//    1. A log call    (SL.log.* or the local log/logInfo/logWarn/logError alias)
//    2. A notify call (popup.js only — SL.notify or notify/notifyOk/notifyErr)
//
//  Run manually:        node scripts/check-instrumentation.mjs
//  Run with hook:       wired via .claude/settings.local.json Stop hook
//
//  Exit codes:
//    0 → all good
//    1 → gaps found (script prints offending file:line entries)
// ═══════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..");

// Files we lint — extension JS that runs in popup, background, or content scripts.
const FILES = [
  "popup.js",
  "background.js",
  "nfe.js",
  "unhook.js",
  "xunhook.js",
  "darkmode.js",
  "nocookie.js",
  "livecss.js",
  "jsonformat.js",
  "gmaps.js",
  "viewimage.js",
];

const POPUP_FILE = "popup.js";

// Events that represent a user action. We deliberately exclude "input" — it
// fires on every keystroke and would spam notifications.
const REQUIRED_EVENT_RE = /addEventListener\s*\(\s*["'`](click|change|submit)["'`]/g;

// Patterns that count as "logging" or "notifying" inside a handler block.
const HAS_LOG = /\b(SL\.log\.|log\(|logInfo\(|logWarn\(|logError\()/;
const HAS_NOTIFY = /\b(SL\.notify\(|notify\(|notifyOk\(|notifyErr\()/;

// Opt-out comments. Author can declare a handler doesn't need a notify
// (pure UI state) or doesn't need a log. Format MUST include a reason after the colon
// so future readers understand the omission.
const SKIP_NOTIFY = /\/\/\s*no-notify:\s*\S+/;
const SKIP_LOG    = /\/\/\s*no-log:\s*\S+/;

// A short body that *only* contains a function call is treated as a
// delegation to a named function — e.g. `() => doX()` or just `enterPiP`.
// Those should be flagged as ambiguous so the author either inlines a log
// or moves the handler body inline.
function isShortDelegation(body) {
  const trimmed = body.replace(/\s+/g, " ").trim();
  // Body without braces — expression-form arrow or named function reference.
  if (!trimmed.includes("{")) return true;
  // Single-statement body with no logging at all and < 80 chars.
  return trimmed.length < 80 && !HAS_LOG.test(trimmed);
}

/**
 * Extract the handler body for one addEventListener call.
 * Returns the substring covering the handler argument (block or expression).
 */
function extractHandlerBody(source, listenerStart) {
  // Position after the literal `addEventListener(`
  const parenIdx = source.indexOf("(", listenerStart);
  if (parenIdx === -1) return "";

  // Walk forward, tracking string/regex/comment context very loosely.
  // Goal: find the first `{` that belongs to the handler's body, then
  // balance braces to its matching close.
  let i = parenIdx + 1;
  let parenDepth = 1;
  let inSingle = false, inDouble = false, inTick = false, inLine = false, inBlock = false;
  let braceStart = -1;

  for (; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];

    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && source[i + 1] === "/") { inBlock = false; i++; } continue; }
    if (inSingle) { if (ch === "'" && prev !== "\\") inSingle = false; continue; }
    if (inDouble) { if (ch === '"' && prev !== "\\") inDouble = false; continue; }
    if (inTick)   { if (ch === "`" && prev !== "\\") inTick = false;  continue; }

    if (ch === "/" && source[i + 1] === "/") { inLine = true; continue; }
    if (ch === "/" && source[i + 1] === "*") { inBlock = true; i++; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "`") { inTick = true; continue; }

    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        // End of addEventListener call without ever finding a brace body.
        // Return the whole argument range so caller can inspect it.
        return source.slice(parenIdx, i + 1);
      }
    } else if (ch === "{" && parenDepth === 1) {
      braceStart = i;
      // Now find the matching `}` for this handler body.
      let braceDepth = 1;
      let j = i + 1;
      let s = false, d = false, t = false, l = false, b = false;
      for (; j < source.length; j++) {
        const c2 = source[j];
        const p2 = source[j - 1];
        if (l) { if (c2 === "\n") l = false; continue; }
        if (b) { if (c2 === "*" && source[j + 1] === "/") { b = false; j++; } continue; }
        if (s) { if (c2 === "'" && p2 !== "\\") s = false; continue; }
        if (d) { if (c2 === '"' && p2 !== "\\") d = false; continue; }
        if (t) { if (c2 === "`" && p2 !== "\\") t = false; continue; }
        if (c2 === "/" && source[j + 1] === "/") { l = true; continue; }
        if (c2 === "/" && source[j + 1] === "*") { b = true; j++; continue; }
        if (c2 === "'") { s = true; continue; }
        if (c2 === '"') { d = true; continue; }
        if (c2 === "`") { t = true; continue; }
        if (c2 === "{") braceDepth++;
        else if (c2 === "}") {
          braceDepth--;
          if (braceDepth === 0) {
            return source.slice(braceStart, j + 1);
          }
        }
      }
      return source.slice(braceStart);
    }
  }
  return "";
}

function lineOf(source, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (source[i] === "\n") line++;
  return line;
}

const issues = [];

for (const file of FILES) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) continue;
  const source = fs.readFileSync(fp, "utf8");

  REQUIRED_EVENT_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRED_EVENT_RE.exec(source))) {
    const event = m[1];
    const startIdx = m.index;
    const body = extractHandlerBody(source, startIdx);
    const line = lineOf(source, startIdx);
    const hasLog = HAS_LOG.test(body);
    const hasNotify = HAS_NOTIFY.test(body);
    const skipNotify = SKIP_NOTIFY.test(body);
    const skipLog = SKIP_LOG.test(body);
    const delegated = isShortDelegation(body);

    if (!hasLog && !delegated && !skipLog) {
      issues.push({ file, line, event, kind: "missing-log" });
    } else if (!hasLog && delegated && !skipLog) {
      issues.push({ file, line, event, kind: "delegating-handler-without-inline-log",
        hint: "Either inline a log() call here, or open the named function it delegates to and add one there." });
    }
    if (file === POPUP_FILE && !hasNotify && !delegated && !skipNotify) {
      issues.push({ file, line, event, kind: "missing-notify" });
    }
  }
}

if (issues.length === 0) {
  console.log("✓ instrumentation check passed — all click/change/submit handlers in extension code have logs"
    + " (and notify calls in popup.js).");
  process.exit(0);
}

// Group by file for readability
const byFile = new Map();
for (const i of issues) {
  if (!byFile.has(i.file)) byFile.set(i.file, []);
  byFile.get(i.file).push(i);
}

console.error("✗ instrumentation gaps detected:");
console.error("");
for (const [file, list] of byFile) {
  console.error(`  ${file}:`);
  for (const i of list) {
    let line = `    line ${i.line}  ${i.kind}  addEventListener("${i.event}", …)`;
    if (i.hint) line += `\n        hint: ${i.hint}`;
    console.error(line);
  }
}
console.error("");
console.error("How to fix:");
console.error("  • Logging:       add `log(\"module.action\", { …data })` inside each handler block");
console.error("                   (or SL.log.action / SL.log.info / etc. outside popup.js).");
console.error("  • Notifications: add `notify(\"message\", \"ok\"|\"err\"|\"info\")` in popup.js handlers,");
console.error("                   once per user-visible outcome. notifyOk()/notifyErr() are shortcuts.");
console.error("  • Delegating handlers like `el.addEventListener(\"click\", namedFn)` confuse this");
console.error("    check — inline the body or wrap with `() => { log(...); namedFn(); }`.");
console.error("  • Pure UI handlers that legitimately need neither can opt out with a comment:");
console.error("        // no-notify: just UI state, no user-visible action");
console.error("        // no-log:    likewise (rarely justified — keep logs for debugging)");
process.exit(1);
