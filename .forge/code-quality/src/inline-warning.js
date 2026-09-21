import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A design-system form control must be able to announce its error at the control. A field
 * wrapper injecting `aria-invalid` and `aria-describedby` through `cloneElement` cannot reach
 * a control with a closed prop list, so helper text renders while no screen reader ties it to
 * the input. Regex over TSX, so a control assembled at runtime is invisible.
 */

export const DESIGN_SYSTEM = /(?:^|\/)(?:ui|primitives|forms)(?:\/|$)/;

// A worktree is never scanned, by any route: the walk prunes these names, and OFF_LIMITS
// re-checks the final list so an explicit directory cannot reach one either.
const SKIP_DIR = /^(?:\.|worktrees$|node_modules$|dist$|build$|out$|coverage$|__snapshots__$)/;
const OFF_LIMITS = /(?:^|\/)(?:\.[^/]*|worktrees|node_modules|dist|build|out|coverage)(?:\/|$)/;

// A root handed in from outside gets the same treatment as one the walk found, so pointing
// the scan straight at a worktree reaches nothing.
const ROOT_OFF_LIMITS = /(?:^|\/)(?:worktrees|\.claude|\.git|node_modules)(?:\/|$)/;

// THIS LIST IS THE MECHANISM: a control absent here is never judged. A bare `<button>` is an
// action, not a field; an ARIA role is what promotes one to a control.
const CONTROL =
  /<(?:input|select|textarea)\b|role=["'](?:checkbox|switch|radio|radiogroup|combobox|listbox|spinbutton|slider|searchbox|textbox)["']/;

const COMPONENT_RE = /function\s+([A-Z]\w*)\s*[(<]/g;
const ALERT = /role=["']alert["']/;
const INVALID = /aria-invalid/;
const DESCRIBED = /aria-describedby/;
const FORWARDS = /\{\s*\.\.\.\w+\s*\}/;

// The reason is mandatory: a bare marker fails, and every waiver is reported.
const WAIVER = /inline-warning:\s*none\s*[—-]\s*(\S[^\n]*)/;

function walk(absolute, base, out) {
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const next = path.join(base, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) walk(path.join(absolute, entry.name), next, out);
    } else if (/\.(?:tsx|jsx)$/.test(entry.name) && !/\.(?:test|spec|stories)\./.test(entry.name)) {
      out.push(next);
    }
  }
  return out;
}

function components(source) {
  const found = [...source.matchAll(COMPONENT_RE)].map((m) => ({ name: m[1], start: m.index }));
  return found.map((entry, index) => ({
    name: entry.name,
    line: source.slice(0, entry.start).split("\n").length,
    body: source.slice(entry.start, found[index + 1]?.start ?? source.length),
    leading: source.slice(found[index - 1]?.start ?? 0, entry.start),
  }));
}

function judge(body) {
  if (ALERT.test(body) && INVALID.test(body) && DESCRIBED.test(body)) return null;
  if (ALERT.test(body)) {
    return "renders error text the control never points at — add aria-invalid and aria-describedby";
  }
  if (FORWARDS.test(body)) return null;
  return "no inline error path — render a wired error, or spread unknown props so a field wrapper can inject them";
}

/**
 * Controls that cannot surface an inline error. `all` skips the design-system filter for a
 * caller that wants feature screens judged too.
 */
export function findInlineWarningGaps({ roots = ["."], all = false } = {}) {
  const found = new Map();
  for (const root of roots) {
    const absolute = path.resolve(root);
    if (ROOT_OFF_LIMITS.test(absolute)) continue;
    for (const relative of walk(absolute, "", [])) {
      if (OFF_LIMITS.test(relative)) continue;
      if (!all && !DESIGN_SYSTEM.test(path.dirname(relative))) continue;
      const target = path.join(absolute, relative);
      found.set(target, path.relative(process.cwd(), target) || relative);
    }
  }

  const scanned = [...found.values()].sort();
  const violations = [];
  const waivers = [];
  let controlCount = 0;

  for (const [target, file] of [...found].sort((a, b) => a[1].localeCompare(b[1]))) {
    let source;
    try {
      source = readFileSync(target, "utf8");
    } catch {
      violations.push({ file, component: "(file)", reason: "unreadable" });
      continue;
    }
    for (const { name, line, body, leading } of components(source)) {
      if (!CONTROL.test(body)) continue;
      controlCount += 1;
      const waived = WAIVER.exec(leading) ?? WAIVER.exec(body);
      if (waived) {
        waivers.push({ file, line, component: name, reason: waived[1].trim() });
        continue;
      }
      const reason = judge(body);
      if (reason) violations.push({ file, line, component: name, reason });
    }
  }

  return { files: scanned, controlCount, waivers, violations };
}
