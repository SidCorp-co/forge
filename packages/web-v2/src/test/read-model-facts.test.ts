// REQ-12 BC-19: every derived fact a screen reads is computed by one core read model, in a contracts
// shape, and web renders it. Each rule names a fact web once derived in a component and the read model
// that serves it now; a component that derives it again fails here naming the rule. The rules read the
// feature sources, so a plant in any component is caught where it is written.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

interface Rule {
  name: string;
  /** What core serves instead, so the refusal says where to read it. */
  servedBy: string;
  pattern: RegExp;
}

export const RULES: Rule[] = [
  {
    name: "fleet-online-runners",
    servedBy: "GET /agent-sessions/queue-stats `onlineRunners`",
    pattern: /\.status\s*===\s*["']online["']\s*\)\s*\.length/,
  },
  {
    name: "fleet-queued-count",
    servedBy: "GET /agent-sessions/queue-stats `waiting`",
    pattern: /\.filter\([^\n]*["']queued["'][^\n]*["']idle["'][^\n]*\)\s*\.length/,
  },
  {
    name: "fleet-dispatch-stalled",
    servedBy: "GET /agent-sessions/queue-stats `dispatchStalled` (contracts isDispatchStalled)",
    pattern: /(queuedCount|waiting)\s*>\s*0\s*&&\s*\w*[oO]nline\w*\s*===\s*0/,
  },
  {
    name: "revision-changed-since-base",
    servedBy: "the revision's `specChanges` (contracts specChangesOf)",
    pattern: /!\s*(before|was)\.includes\(/,
  },
  {
    name: "attention-needs-you-refilter",
    servedBy: "GET /me/attention `needsYou`, scoped by `orgId`",
    pattern: /\.needsYou\.filter\(|needsYou\.reduce\(/,
  },
  {
    name: "attention-match-count",
    servedBy: "GET /me/attention `counts` and `total`",
    pattern: /offlineRunners\s*=\s*\(?\s*\w+\.data\b|\.filter\(\s*\(?d\)?\s*=>\s*d\.status\s*===\s*["']offline["']/,
  },
  {
    name: "attention-org-scope",
    servedBy: "GET /me/attention `orgId` (contracts inActiveOrg)",
    pattern: /view\.\w+\.filter\(keep\)|projectSlugs\.has\(n\.projectSlug\)/,
  },
];

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** The rules a source text breaks, each with the first line it breaks on. */
export function derivations(text: string): { rule: string; servedBy: string; line: number }[] {
  const lines = text.split("\n");
  return RULES.flatMap((r) => {
    const at = lines.findIndex((l) => r.pattern.test(l));
    return at === -1 ? [] : [{ rule: r.name, servedBy: r.servedBy, line: at + 1 }];
  });
}

describe("read-model facts are rendered, never derived (REQ-12 BC-19)", () => {
  it("no component derives a fact a core read model serves", () => {
    const found = sources(join(SRC, "features")).flatMap((file) =>
      derivations(readFileSync(file, "utf8")).map((d) => `${d.rule} at ${relative(SRC, file)}:${d.line}, read ${d.servedBy}`),
    );
    expect(found).toEqual([]);
  });

  it.each([
    ["fleet-online-runners", 'const n = devicePool.filter((d) => d.status === "online").length;'],
    ["fleet-queued-count", 'const q = rows.filter((r) => r.status === "queued" || r.status === "idle").length;'],
    ["fleet-dispatch-stalled", "const s = queuedCount > 0 && onlineRunners === 0;"],
    ["revision-changed-since-base", "const added = after.filter((x) => !before.includes(x));"],
    ["attention-needs-you-refilter", "const n = view.needsYou.filter((x) => ok(x));"],
    ["attention-match-count", 'const off = devices.filter((d) => d.status === "offline");'],
    ["attention-org-scope", "const m = view.mentions.filter(keep);"],
  ])("refuses a planted %s derivation by name", (rule, planted) => {
    expect(derivations(planted).map((d) => d.rule)).toEqual([rule]);
  });

  it("passes the rendering of what core serves", () => {
    expect(derivations("const stalled = queueQ.data?.dispatchStalled ?? false;\nconst n = view.counts.mentions;")).toEqual([]);
  });
});
