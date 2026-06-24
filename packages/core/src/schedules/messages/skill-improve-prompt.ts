// Skill-improve prompt builder — ISS-548.
//
// Builds the agent prompt for a skill-improve schedule run and provides
// helpers to parse the structured report the agent embeds in its final
// message (used for idempotency write-back at session completion).

import type { ScheduleMode } from '../../db/schema.js';
import { type ImprovementMessage, getImprovementMessage } from './registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Tracks which message versions have been applied per key. */
export type AppliedVersions = Record<string, number>;

export interface SkillImproveReportEntry {
  key: string;
  version: number;
  /** applied = skill updated (auto); proposed = draft issue created (propose); skipped = appliesWhen false */
  status: 'applied' | 'proposed' | 'skipped';
  /** Required when status=skipped; brief reason why appliesWhen evaluated false. */
  reason?: string;
}

export interface SkillImprovePromptInput {
  templateKey: string;
  mode: ScheduleMode;
  /** Existing applied versions from schedules.applied_message_versions; null = none applied yet. */
  appliedMessageVersions: AppliedVersions | null;
}

// ── Sentinel ──────────────────────────────────────────────────────────────────

/** Prefix the agent must write on its own line immediately before the JSON report. */
export const SKILL_IMPROVE_REPORT_SENTINEL = 'SKILL_IMPROVE_REPORT_JSON:';

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the skill-improve agent prompt for the given schedule.
 *
 * Returns `null` when the message is already applied at its current version
 * (idempotency — caller should skip dispatch in this case).
 */
export function buildSkillImprovePrompt(input: SkillImprovePromptInput): string | null {
  const { templateKey, mode, appliedMessageVersions } = input;

  const msg = getImprovementMessage(templateKey);
  if (!msg) return null;

  // Idempotency gate: skip if the recorded applied version ≥ registry version.
  const appliedVersion = appliedMessageVersions?.[msg.key] ?? 0;
  if (appliedVersion >= msg.version) return null;

  return buildPromptText(msg, mode);
}

function buildPromptText(msg: ImprovementMessage, mode: ScheduleMode): string {
  const skillList = msg.appliesToSkills?.join(', ') ?? 'relevant skills';

  return `You are the Forge skill-improve agent running a scheduled improvement pass for this project.

## Improvement Message
Key: ${msg.key} (version ${msg.version})
Title: ${msg.title}
Applies to skills: ${skillList}

### Improvement guidance
${msg.message}

### Why this matters
${msg.rationale}
${
  msg.appliesWhen
    ? `
### Applies when
${msg.appliesWhen}`
    : ''
}

---

## Your task — execute every step in order

### Step 1 — Read 4 context sources (do this BEFORE evaluating anything)

**a) Project skills**
Call forge_skills.list with scope="project" to get the skill list.
Then call forge_skills.get for each skill listed in "Applies to skills" above (plus related skills you discover).

**b) Project knowledge**
Call forge_knowledge (list/get/search) to retrieve project knowledge entries. They document project structure, conventions, stack, and key decisions.

**c) Project memory**
Call forge_memory_search with:
  - query: "${msg.key} conventions idiom fix-pattern"
  - topK: 5
  - sourceFilter: ["knowledge", "decision", "fix-pattern"]
Also try a second search with query: "${skillList} idiom pattern" to surface project-specific patterns.

**d) Recent pipeline runs**
Call forge_project_pipeline_runs (or forge_pipeline_runs_get) to retrieve the 20 most recent runs.
Look for any with status=reopen or failure patterns relevant to the skills above — they signal gaps the improvement should address.

### Step 2 — Evaluate appliesWhen
${
  msg.appliesWhen
    ? `The condition that must hold for this improvement to be relevant is:
> "${msg.appliesWhen}"

Read the project configuration (baseBranch, productionBranch, mergeStates, pipelineConfig, projectFacts) via forge_config.
Make a judgment: does this condition hold for this project?

- If NOT met → write a one-sentence reason, then go directly to Step 5 and report status="skipped" with that reason. Do not propose or apply.
- If met → proceed to Step 3.`
    : `No specific condition is required — proceed directly to Step 3.`
}

### Step 3 — Compose a TAILORED improvement

The "Improvement guidance" above is a GUIDELINE, not a global skill to copy verbatim.
Adapt it to THIS project:

- Read the CURRENT body of the target skill(s): ${skillList}.
- Identify the specific section or behavior the guidance addresses.
- Write a minimal, targeted change that incorporates the guidance in a way that fits THIS project's existing idiom, terminology, and workflow patterns.
- Do NOT wholesale-replace the skill. Change only what the guidance requires.
- Verify the proposed change does not conflict with project conventions you discovered in Step 1.

### Step 4 — Apply per mode

Current mode: **${mode}**

${
  mode === 'propose'
    ? `Create a DRAFT issue (status="draft") via forge_issues.create:
  - title: "Improve ${skillList}: ${msg.title}"
  - description: The proposed skill change as a fenced markdown code block (or a diff), plus a brief rationale for why it applies to this project.
  - category: "feature"
Do NOT modify the skill file directly — this is a proposal for human review.`
    : `Call forge_skills.update to apply the improvement directly to the target skill(s).
Report the exact change you made and why it fits this project.`
}

### Step 5 — Output the run report (REQUIRED — this is your LAST action)

After the action in Step 4 is complete, write the following sentinel on its own line, immediately followed by a single JSON object on the next line (no trailing text):

${SKILL_IMPROVE_REPORT_SENTINEL}
{"key":"${msg.key}","version":${msg.version},"status":"<applied|proposed|skipped>","reason":"<reason if skipped — omit key otherwise>"}

Replace the placeholders:
- "applied" — you updated the skill directly (mode=auto path was taken)
- "proposed" — you created a draft issue (mode=propose path was taken)
- "skipped" — appliesWhen evaluated false (include a brief reason)

This JSON is parsed by the platform to track idempotency. Output ONLY the sentinel line and the JSON line — no extra text between them.`;
}

// ── Report parsing ────────────────────────────────────────────────────────────

/**
 * Parses the structured report the agent embeds in its final message.
 *
 * Returns null when no sentinel is found or JSON is malformed.
 * Only `applied` and `proposed` outcomes are recorded in `updatedVersions`;
 * `skipped` is intentionally excluded so a later config change re-triggers
 * the message (see idempotency spec).
 */
export function parseSkillImproveReport(text: string): {
  entries: SkillImproveReportEntry[];
  updatedVersions: AppliedVersions;
} | null {
  const idx = text.indexOf(SKILL_IMPROVE_REPORT_SENTINEL);
  if (idx === -1) return null;

  const afterSentinel = text.slice(idx + SKILL_IMPROVE_REPORT_SENTINEL.length).trimStart();
  // Take up to the first newline after the sentinel to isolate the JSON line.
  const nlIdx = afterSentinel.indexOf('\n');
  const jsonLine = nlIdx === -1 ? afterSentinel : afterSentinel.slice(0, nlIdx);
  const jsonStr = jsonLine.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!isReportEntry(parsed)) return null;

  const entry = parsed as SkillImproveReportEntry;
  const updatedVersions: AppliedVersions = {};

  if (entry.status === 'applied' || entry.status === 'proposed') {
    updatedVersions[entry.key] = entry.version;
  }

  return { entries: [entry], updatedVersions };
}

function isReportEntry(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === 'string' &&
    typeof o.version === 'number' &&
    (o.status === 'applied' || o.status === 'proposed' || o.status === 'skipped')
  );
}

/**
 * Scans session messages (from `agentSessions.messages` JSONB) for an
 * embedded skill-improve report. Scans from the end for efficiency.
 * Handles both string content and Anthropic multi-block content arrays.
 */
export function extractReportFromMessages(messages: unknown[]): {
  entries: SkillImproveReportEntry[];
  updatedVersions: AppliedVersions;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== 'assistant') continue;

    const text = extractTextContent(m.content);
    if (!text) continue;

    const result = parseSkillImproveReport(text);
    if (result) return result;
  }
  return null;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}
