#!/usr/bin/env node
// ═══════════════════════════════════
//  Security linter for SuperLevels
//
//  Enforces the patterns CLAUDE.md lists as "no exceptions". This extension
//  holds <all_urls> + cookies + history + bookmarks + scripting, so one XSS
//  or code-injection in an extension page = full credential theft.
//
//  What this catches:
//    • eval, new Function, setTimeout/setInterval with string argument
//    • innerHTML / outerHTML / insertAdjacentHTML assignments
//      (suppress per-line with `// safe-html: <one-line reason>`)
//    • document.write / document.writeln (never allowed)
//    • chrome.scripting.executeScript({ code: ... }) — only { func } allowed
//    • Remote <script src="https?://..."> in HTML
//
//  Run:   node scripts/check-security.mjs
//  Exit:  0 = clean; 1 = violations.
// ═══════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..");

const FILES = [
  "popup.js", "popup.html",
  "background.js", "logger.js",
  "nfe.js", "unhook.js", "xunhook.js",
  "darkmode.js", "nocookie.js", "livecss.js", "jsonformat.js",
  "gmaps.js", "viewimage.js",
  "teams.js",
];

const OPT_OUT_RE = /\/\/\s*safe-html:\s*\S/;

const RULES = [
  {
    name: "eval",
    re: /\beval\s*\(/g,
    why: "eval() is banned — XSS pivot point.",
    optable: false,
  },
  {
    name: "new-Function",
    re: /\bnew\s+Function\s*\(/g,
    why: "new Function() is banned — equivalent to eval.",
    optable: false,
  },
  {
    name: "setTimeout-string",
    re: /\bsetTimeout\s*\(\s*["'`]/g,
    why: "setTimeout with a string argument is eval. Pass a function.",
    optable: false,
  },
  {
    name: "setInterval-string",
    re: /\bsetInterval\s*\(\s*["'`]/g,
    why: "setInterval with a string argument is eval. Pass a function.",
    optable: false,
  },
  {
    name: "innerHTML",
    re: /\.innerHTML\s*=/g,
    why: "innerHTML assignment can XSS if RHS isn't escaped. Use textContent/createElement, or annotate `// safe-html: <reason>` if every interpolation goes through esc()/escA().",
    optable: true,
  },
  {
    name: "outerHTML",
    re: /\.outerHTML\s*=/g,
    why: "outerHTML assignment can XSS. Use createElement, or annotate `// safe-html: <reason>`.",
    optable: true,
  },
  {
    name: "insertAdjacentHTML",
    re: /\.insertAdjacentHTML\s*\(/g,
    why: "insertAdjacentHTML can XSS. Use insertAdjacentElement, or annotate `// safe-html: <reason>`.",
    optable: true,
  },
  {
    name: "document.write",
    re: /\bdocument\.write(?:ln)?\s*\(/g,
    why: "document.write / writeln is banned. Use DOM APIs.",
    optable: false,
  },
  {
    name: "executeScript-code",
    // chrome.scripting.executeScript({ ..., code: "..." })
    re: /executeScript\s*\(\s*\{[\s\S]{0,200}?\bcode\s*:/g,
    why: "chrome.scripting.executeScript({ code }) is banned — only { func } allowed. func gets serialized statically; closure variables don't leak.",
    optable: false,
  },
  {
    name: "remote-script",
    re: /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//gi,
    why: "Remote <script src=> in extension page violates MV3 CSP and the no-remote-code rule.",
    optable: false,
  },
];

function lineOf(source, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (source[i] === "\n") line++;
  return line;
}

function getLine(source, lineNum) {
  const lines = source.split("\n");
  return lines[lineNum - 1] || "";
}

// Allow `// safe-html: <reason>` on the same line as the violation OR on the
// immediately preceding line. The latter is needed for multi-line templates
// where the `// ...` would otherwise end up inside the backtick string.
function hasOptOut(source, lineNum) {
  const cur = getLine(source, lineNum);
  if (OPT_OUT_RE.test(cur)) return true;
  const prev = getLine(source, lineNum - 1);
  if (OPT_OUT_RE.test(prev)) return true;
  return false;
}

function isCommentedOut(src, idx) {
  // Skip matches that appear inside // line comments. (Block comments and
  // strings are not handled — keep the lint deliberately conservative;
  // false positives are easier to spot than misses.)
  const before = src.slice(0, idx);
  const lineStart = before.lastIndexOf("\n") + 1;
  const linePrefix = src.slice(lineStart, idx);
  return linePrefix.includes("//");
}

const violations = [];
for (const file of FILES) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, "utf8");

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src))) {
      if (isCommentedOut(src, m.index)) continue;
      const line = lineOf(src, m.index);
      const lineContent = getLine(src, line);
      if (rule.optable && hasOptOut(src, line)) continue;
      violations.push({
        file, line, rule: rule.name, why: rule.why,
        snippet: lineContent.trim().slice(0, 140),
      });
    }
  }
}

if (violations.length === 0) {
  console.log("✓ security check passed — no dangerous patterns found in extension code.");
  process.exit(0);
}

const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

console.error("✗ security violations:");
console.error("");
for (const [file, list] of byFile) {
  console.error(`  ${file}:`);
  for (const v of list) {
    console.error(`    line ${v.line}  [${v.rule}]  ${v.snippet}`);
    console.error(`        ${v.why}`);
  }
}
console.error("");
console.error("Suppress innerHTML/outerHTML/insertAdjacentHTML on a verified-safe line with:");
console.error("    // safe-html: <reason — e.g. all interpolations routed through esc()/escA()>");
console.error("All other rules are hard bans — no opt-out.");
process.exit(1);
