import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationDetail } from "./standing-copy";

// Core's sentence on an integration row's health, read by the shape of its English: each one is
// still built by core from these pieces, reads back unchanged in en, and in vi keeps the provider,
// the host and the adapter's own words.

const coreDir = resolve(__dirname, "../../../../core/src");
const adapters = readdirSync(resolve(coreDir, "integrations"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const dir = resolve(coreDir, "integrations", d.name);
    return readdirSync(dir).filter((f) => f === "adapter.ts").map((f) => readFileSync(resolve(dir, f), "utf8"));
  });
const src = [readFileSync(resolve(coreDir, "integration-door/status-service.ts"), "utf8"), readFileSync(resolve(coreDir, "integrations/deploy/coolify/adapter.ts"), "utf8"), ...adapters].join("\n");

const COST = "Forge cannot read its commits, merge into it or compare branches, so a release cannot tell what already shipped";

const DETAILS: [string, string[]][] = [
  ["no Sentry integration configured", ["detail: `no ${opts.label} integration configured`"]],
  ["integration disabled", ["'integration disabled'"]],
  ["last health: error", ["`last health: ${row.lastHealthStatus}"]],
  ["last health: error — 401 from logs.example.com", ["` — ${row.lastHealthDetail}`"]],
  ["never test-connected", ["neverCheckedDetail: 'never test-connected'"]],
  ["never health-checked", ["neverCheckedDetail: 'never health-checked'"]],
  ["Never checked — run Test connection to probe the App installation and the repository.", ["'Never checked — run Test connection to probe the App installation and the repository.'"]],
  ["Never checked — run Test connection to probe the token and the project webhook.", ["'Never checked — run Test connection to probe the token and the project webhook.'"]],
  ["the project document declares no repository", ["'the project document declares no repository'"]],
  [`a local path no host serves: ${COST}. Its head is read from a runner's bound checkout; declare the hosted repository to read the rest`, ["`a local path no host serves: ${UNREACHED_COST}. Its head is read from a runner's bound checkout; declare the hosted repository to read the rest`", COST]],
  [`no source host binding reaches github.com: ${COST}. Connect GitHub to fix it`, ["`no source host binding reaches ${host}: ${UNREACHED_COST}. ${", "`Connect ${serving.label} to fix it`"]],
  [`no source host binding reaches git.example.com: ${COST}. Bind a source host connection serving git.example.com to fix it`, ["`Bind a source host connection serving ${host} to fix it`"]],
  [`the GitHub binding that reaches it is switched off: ${COST}`, ["`the ${reached.label} binding that reaches it is switched off: ${UNREACHED_COST}`"]],
  ["read through GitLab — last health: needs_reauth", ["`read through ${reached.label} — last health: ${connection.lastHealthStatus}`"]],
  ["read through GitLab — never health-checked", ["`read through ${reached.label} — never health-checked`"]],
];

describe("core's sentence on an integration row's health, mapped by the shape of its English", () => {
  it("reads core's source: it still builds each sentence from these pieces", () => {
    for (const [sentence, pieces] of DETAILS) for (const piece of pieces) expect(src.includes(piece), `${piece} (of: ${sentence})`).toBe(true);
  });

  it("the en copy file spells every sentence as core writes it", () => {
    for (const [s] of DETAILS) expect(integrationDetail(s, "en"), s).toBe(s);
  });

  it("reads each in vi, carrying the provider, the host and the adapter's own words over", () => {
    const CARRIED = /\bSentry\b|\bGitHub\b|\bGitLab\b|github\.com|git\.example\.com|401 from logs\.example\.com/g;
    // two English words in a row that are not a name core carried over are core's sentence left unread
    const pairs = (text: string) => {
      const words = text.replace(CARRIED, " | ").toLowerCase().split(/\s+/);
      return words.slice(1).map((w, i) => `${words[i]} ${w}`).filter((p) => /^[a-z']+:? [a-z']+:?$/.test(p));
    };
    for (const [s] of DETAILS) {
      const read = integrationDetail(s, "vi");
      for (const pair of pairs(s)) expect(read.toLowerCase(), `${s} → "${pair}"`).not.toContain(pair);
      for (const token of s.match(CARRIED) ?? []) expect(read, s).toContain(token);
    }
    expect(integrationDetail("last health: needs_reauth", "vi")).not.toContain("needs_reauth");
  });

  it("leaves a sentence it does not know as core wrote it", () => {
    expect(integrationDetail("a detail core added later", "vi")).toBe("a detail core added later");
  });
});
