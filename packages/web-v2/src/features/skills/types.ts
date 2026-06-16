// web-v2 feature module: skills registry. Shapes verified against
// `packages/core/src/skills/{crud-routes,routes}.ts` for ISS-299:
//  - GET  /api/skills?projectId&scope          → SkillRow[]
//  - POST /api/skills/sync-status {projectId}   → SkillSyncStatus[]
//  - GET  /api/projects/:id/skill-registrations → { registrations: SkillRegistration[] }
//  - POST /api/projects/:id/skills/:sid/register {stage}
//  - DELETE /api/projects/:id/skills/registrations/:stage
export type SkillScope = "global" | "project";

/** Runtime context a skill targets — mirrors core `skillTargets`. */
export const SKILL_TARGETS = ["dev", "cloud", "all"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

/** A supporting file inside a skill's folder (e.g. `references/foo.md`,
 *  `scripts/run.sh`). `SKILL.md` is NOT here — it lives in the `skillMd`
 *  column. Mirrors core `fileSchema` (`{ path, content, encoding }`). */
export interface SkillFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/** A registerable pipeline stage = an `issueStatus` value (core enum). The
 *  register endpoint accepts the full status set; these are the 8 pipeline
 *  states that actually drive a skill in this project's ladder — one per
 *  `auto*` toggle in the Pipeline settings tab (`PIPELINE_STEPS` in core's
 *  `pipeline/registry.ts`). `clarified` (plan) and `reopen` (fix) were missing
 *  here, which made those two stages impossible to bind from the web UI even
 *  though their toggles still demand a registered skill — a hard dead-end. */
export const REGISTERABLE_STAGES = [
  "open",
  "confirmed",
  "clarified",
  "approved",
  "developed",
  "testing",
  "reopen",
  "released",
] as const;
export type RegisterableStage = (typeof REGISTERABLE_STAGES)[number];

/** Human label for each registerable stage — the raw `issueStatus` value is
 *  what gets stored, but `open`/`reopen`/`developed` read poorly in a picker.
 *  The label names the JOB that runs there so it lines up with the Pipeline
 *  tab's `Auto triage`/`Auto plan`/… rows. */
export const STAGE_LABELS: Record<RegisterableStage, string> = {
  open: "Triage",
  confirmed: "Clarify",
  clarified: "Plan",
  approved: "Code",
  developed: "Review",
  testing: "Test",
  reopen: "Fix",
  released: "Release",
};

/** Flat skill row from `GET /api/skills`. The list endpoint returns the full
 *  row, so `skillMd` + `files` are present and drive the Studio editor. */
export interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  scope: SkillScope;
  projectId: string | null;
  version: number | null;
  contentHash: string | null;
  target: SkillTarget | null;
  source: string | null;
  tools: string[] | null;
  /** The SKILL.md body+frontmatter. Null only for legacy prompt-only rows. */
  skillMd: string | null;
  /** Supporting files in the skill folder (default []). */
  files: SkillFile[];
  /** True when this is a platform-managed META skill (`forge-skills`…) served
   *  LIVE as an MCP prompt — NOT disk-synced. Such skills have no device
   *  sync-status and are not bound to a pipeline stage. The list endpoint
   *  computes it from core's `MANAGED_META_SKILLS`; older responses omit it,
   *  so treat a missing value as `false`. */
  managedMeta?: boolean;
  updatedAt: string;
  createdAt: string;
}

/** One row of `POST /api/skills/sync-status` — the per-skill registered stages
 *  (= where the skill is enabled) plus the stored hash/version. */
export interface SkillSyncStatus {
  skillId: string;
  skillName: string;
  target: string | null;
  scope: SkillScope;
  currentHash: string | null;
  currentVersion: number | null;
  updatedAt: string;
  registeredStages: string[];
}

/** One per-stage binding from `GET /skill-registrations`. */
export interface SkillRegistration {
  stage: string;
  skillId: string;
  skillName: string;
  skillScope: SkillScope;
  registeredBy: string | null;
  createdAt: string;
}

// ── Smoke-verify (ISS-455) — shapes verified against
// `packages/core/src/skills/smoke-verify.ts` ─────────────────────────────────

/** Tier-1 static-check verdict for one pipeline stage. Evidence-based:
 *  registration → usable project skill → a device reported the matching
 *  installed hash. `no_device_report` is the honest WARN-style FAIL for
 *  desktop runners that never report installs. */
export interface SmokeTier1Entry {
  stage: string;
  jobType: string;
  skillId: string | null;
  skillName: string | null;
  status: "PASS" | "FAIL";
  reason:
    | "not_registered"
    | "no_project_skill"
    | "no_bound_runner"
    | "no_device_report"
    | "stale_on_runner"
    | null;
  detail: string | null;
  /** When the static check ran — the report is always computed fresh. */
  checkedAt: string;
  /** For PASS: the newest device `syncedAt` backing the evidence. */
  evidenceAt: string | null;
}

/** Latest tier-2 canary outcome for one stage — the smoke job's terminal
 *  status (`done` → PASS, `failed`/`cancelled` → FAIL, active → PENDING). */
export interface SmokeTier2Entry {
  stage: string;
  jobId: string;
  status: "PASS" | "FAIL" | "PENDING";
  reason: string | null;
  queuedAt: string;
  /** The job's `finishedAt` — "PASS as of <checkedAt>". Null while PENDING. */
  checkedAt: string | null;
}

/** `GET /api/projects/:id/skills/smoke-verify` response. */
export interface SkillSmokeVerifyReport {
  projectId: string;
  generatedAt: string;
  tier1: SmokeTier1Entry[];
  tier2: SmokeTier2Entry[];
}

/** Tier-2 dispatch summary (POST `{tier: 2}` only; null on tier-1 runs). */
export interface SmokeCanaryDispatch {
  dispatched: { stage: string; jobId: string; skillName: string }[];
  skipped: { stage: string; reason: string }[];
}

/** `POST /api/projects/:id/skills/smoke-verify` response. */
export interface SmokeVerifyRunResponse {
  report: SkillSmokeVerifyReport;
  canary: SmokeCanaryDispatch | null;
}

/** List row joined with its sync status — what the card renders. */
export interface SkillView extends SkillRow {
  registeredStages: string[];
  /** Stored in the registry (has a content hash) → considered synced. */
  synced: boolean;
}

/**
 * A pick-able skill for stage binding. Only `scope='project'` skills are
 * registrable; a `global` template that has NOT yet been adopted surfaces as an
 * `adopt` option so the UI can clone-then-register it in one step. See
 * docs/skills-scope-playbook.md.
 */
export type UsableSkillOption =
  | { kind: "project"; skillId: string; name: string }
  | { kind: "adopt"; globalSkillId: string; name: string };

/**
 * Collapse a raw `scope=all` skill list (global ∪ project) into one entry per
 * name (project wins — it's the usable copy). A name with only a global becomes
 * an `adopt` option. Sorted by name for a stable picker order.
 */
export function usableSkillOptions(rows: SkillRow[]): UsableSkillOption[] {
  const project = new Map<string, SkillRow>();
  const global = new Map<string, SkillRow>();
  for (const r of rows) {
    if (r.scope === "project") project.set(r.name, r);
    else if (r.scope === "global") global.set(r.name, r);
  }
  const out: UsableSkillOption[] = [];
  for (const name of new Set([...project.keys(), ...global.keys()])) {
    const p = project.get(name);
    if (p) out.push({ kind: "project", skillId: p.id, name });
    else out.push({ kind: "adopt", globalSkillId: global.get(name)!.id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Names that already have a project-scoped skill — used to hide the redundant
 *  same-name global template card in the Library (the project copy stands in). */
export function projectSkillNames(rows: { scope: SkillScope; name: string }[]): Set<string> {
  return new Set(rows.filter((r) => r.scope === "project").map((r) => r.name));
}

/**
 * Wrap a Studio form (name/description/body) into a full SKILL.md string —
 * a YAML frontmatter block (`name`, `description`) the runner writes verbatim
 * to disk, followed by the markdown body. Values are JSON-quoted (a valid YAML
 * subset) so colons/quotes in the description can't break the frontmatter.
 * `target` is a DB column, not a frontmatter key, so it is NOT emitted here.
 */
export function buildSkillMd(input: { name: string; description: string; body: string }): string {
  const fm = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(
    input.description,
  )}\n---\n`;
  const body = input.body.replace(/^\s+/, "");
  return `${fm}\n${body}\n`;
}

/** Strip a leading YAML frontmatter block from a stored SKILL.md, returning the
 *  editable body. Mirrors core `parse-manifest.ts` FRONTMATTER_RE; tolerates a
 *  file with no frontmatter (returns it unchanged). */
export function splitSkillMd(skillMd: string | null): string {
  if (!skillMd) return "";
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(skillMd);
  return m ? skillMd.slice(m[0].length).replace(/^\s+/, "") : skillMd;
}

/** Join the skill list with the sync-status rows (by skillId). */
export function mergeSkills(rows: SkillRow[], sync: SkillSyncStatus[]): SkillView[] {
  const byId = new Map(sync.map((s) => [s.skillId, s]));
  return rows.map((r) => {
    const s = byId.get(r.id);
    return {
      ...r,
      registeredStages: s?.registeredStages ?? [],
      synced: !!(s?.currentHash ?? r.contentHash),
    };
  });
}
