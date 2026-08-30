import { and, asc, desc, eq, exists, gte, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  comments,
  type IssueStatus,
  issueComplexities,
  issueLabels,
  issuePriorities,
  issueStatuses,
  issues,
  labels,
  taskStatuses,
  tasks,
  waitingKinds,
} from '../../db/schema.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import {
  AttachmentError,
  type DecodedAttachment,
  decodeAndValidateAttachments,
  listIssueAttachments,
  persistDecodedIssueAttachments,
} from '../../issues/attachment-service.js';
import { loadIssueRelations } from '../../issues/dependency-read.js';
import { claimDetectorKey, isValidDetectorKey } from '../../issues/detector-key.js';
import { applyIntakeGate, finalizeIntake } from '../../issues/intake-gate.js';
import { listIssueLabels } from '../../issues/label-service.js';
import {
  collectIssueFieldUpdates,
  MCP_ONLY_ISSUE_PATCH_FIELDS,
  SHARED_ISSUE_PATCH_FIELDS,
} from '../../issues/patch-fields.js';
import { type ReleaseNotes, ReleaseNotesSchema } from '../../issues/release-notes.js';
import { dispatchTickForProject } from '../../jobs/dispatch-tick.js';
import { recordActivityTx } from '../../pipeline/activity.js';
import { hooks } from '../../pipeline/hooks.js';
import { findMissingWorkEvidence } from '../../pipeline/work-evidence.js';
import { markUntrusted, sanitizeUntrusted } from '../../prompt/sanitize.js';
import { applyIssueRelations } from './issue-relations.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalActor,
  principalHookActor,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

// cm:guard NEVER widen this to `decomposes` — that kind runs decomposeParent, which creates an integration branch and parks the parent, and this list is the PAT-reachable write path (ISS-868), so adding it would put runner-shaped side effects behind a credential class the device gate exists to keep out of them. `duplicates`/`parent` are excluded only because they carry no side effect worth an atomic write; route both through forge_project_pm set_dependency.
const relationKinds = ['blocks', 'relates'] as const;

/**
 * Action-based parity port of the legacy Strapi MCP `forge_issues` tool. The
 * single-tool-per-resource shape (one tool, dispatched on an `action` field)
 * preserves the input schema the existing `/forge-*` skills already speak —
 * see ISS-293. Skills round-trip `documentId`, which in the new core maps
 * directly to the issue UUID.
 */

const filtersSchema = z
  .object({
    search: z.string().trim().min(1).optional(),
    status: z.enum(issueStatuses).optional(),
    statusNot: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    updatedAfter: z.string().optional(),
    // listTasks: filter tasks by parent issue UUID + optional task status.
    // `taskStatus` is named separately from the issue-level `status` so a
    // listTasks call cannot accidentally match against issue.status.
    issue: z.uuid().optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    // Label filter: accepts a label name OR uuid (or an array of either).
    // Names are resolved to ids server-side; unknown names short-circuit to empty.
    label: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(50)])
      .optional(),
  })
  .strict()
  .optional();

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

// cm:guard ISS-820 — an agent posting a bare `verifiedX: "..."` / `verifiedX: true` into sessionContext is exactly the fabrication this bound exists to catch (a claim with no evidence, trusted as fact by every later stage); bound-exceed on a pathological payload MUST accept (fail-open), never reject a legitimate large payload
const VERIFIED_KEY_RE = /^verified/i;
// cm:guard ISS-820 — keep this above ~25000: the 200000-byte sessionContext refinement caps a payload at roughly that many nodes, so a lower budget makes the fail-open branch REACHABLE and a bare verified* claim slips through behind padding keys
const VERIFIED_CLAIM_MAX_NODES = 100_000;
const VERIFIED_CLAIM_MAX_DEPTH = 64;
// cm:why matches the ISO-8601 timestamp promised in the violation message — Date.parse alone also accepts non-ISO strings like "2026" or "March 5 2026"
const ISO_8601_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isShapedVerifiedClaim(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const evidence = obj.evidence;
  const evidenceOk =
    (typeof evidence === 'string' && evidence.length > 0) ||
    (Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.every((e) => typeof e === 'string' && e.length > 0));
  if (!evidenceOk) return false;
  const checkedAt = obj.checkedAt;
  // cm:why regex fixes the shape, Date.parse rejects a syntactically-ISO impossibility like 2026-13-45T99:99:99Z
  return (
    typeof checkedAt === 'string' &&
    ISO_8601_DATETIME_RE.test(checkedAt) &&
    !Number.isNaN(Date.parse(checkedAt))
  );
}

interface VerifiedClaimViolation {
  path: string;
  message: string;
}

/**
 * Bounded recursive walk of a sessionContext value looking for a `verified*`
 * key (case-insensitive, any depth) whose value is not shaped
 * `{ evidence: string|string[], checkedAt: ISO timestamp }`. Exported so
 * tests can exercise it directly with a pathological payload.
 */
export function findVerifiedClaimViolation(value: unknown): VerifiedClaimViolation | null {
  let nodeCount = 0;
  let boundExceeded = false;

  function walk(node: unknown, path: string, depth: number): VerifiedClaimViolation | null {
    if (boundExceeded) return null;
    nodeCount++;
    if (nodeCount > VERIFIED_CLAIM_MAX_NODES) {
      // cm:guard ISS-820 — node budget is global (CPU bound): fail-open the whole walk
      boundExceeded = true;
      return null;
    }
    // cm:why depth prunes only this subtree (not global) — a sibling verified* key elsewhere must still be checked, or a one-key-deep decoy bypasses requirement 3
    if (depth > VERIFIED_CLAIM_MAX_DEPTH) {
      return null;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (boundExceeded) return null;
        const violation = walk(node[i], `${path}[${i}]`, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (boundExceeded) return null;
        const childPath = path ? `${path}.${key}` : key;
        if (VERIFIED_KEY_RE.test(key) && !isShapedVerifiedClaim(child)) {
          return {
            path: childPath,
            message: `${childPath}: a verified* claim must be shaped { evidence: string|string[], checkedAt: ISO timestamp } — bare strings/booleans are not evidence`,
          };
        }
        const violation = walk(child, childPath, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    return null;
  }

  return walk(value, '', 0);
}

const dataObject = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    // cm:why setting this on create makes the kernel guarantee at most one live issue per (project, detectorKey) — see issues/detector-key.ts
    detectorKey: z.string().trim().min(1).max(120).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    // sessionContext is opaque JSON the skill pipeline uses to persist
    // accumulated context across sessions. Validated as a record here with a
    // serialised-size ceiling matched to `plan` so a single issue cannot blow
    // up TOAST or query plans (Postgres jsonb has no per-column limit, so we
    // enforce one in app code). Deeper schema lives in the skill spec.
    sessionContext: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .refine((v) => v == null || JSON.stringify(v).length <= 200_000, {
        message: 'sessionContext serialised size exceeds 200000 bytes',
      })
      .superRefine((v, ctx) => {
        if (v == null) return;
        const violation = findVerifiedClaimViolation(v);
        if (violation) {
          ctx.addIssue({ code: 'custom', path: [violation.path], message: violation.message });
        }
      }),
    // ISS-199 — user-facing release notes. forge-clarify writes this; the
    // shape is validated by `ReleaseNotesSchema` so an invalid section enum
    // is rejected at the MCP boundary.
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    // ISS-286 — mark_merged / unmark fields. `issueId` (below) identifies the
    // target issue. `target` is an audit label only — trunk-based v2 has a
    // single `merged_at` column (no `merged_to_prod_at` until v3), so all
    // three values stamp the same column. `mergedAt` overrides the default
    // `now()` stamp; `note` is appended to the audit comment.
    target: z.enum(['feature', 'base', 'prod']).optional(),
    mergedAt: z.string().optional(),
    note: z.string().max(10_000).optional(),
    // Task fields — only consumed by the createTask/updateTask actions. Kept
    // on the same `data` block to avoid splitting the input schema for what
    // is conceptually one tool.
    issueId: z.uuid().optional(),
    taskTitle: z.string().trim().min(1).max(500).optional(),
    taskDescription: z.string().max(50_000).nullable().optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    taskPriority: z.enum(issuePriorities).optional(),
    isAgentTask: z.boolean().optional(),
    taskAcceptanceCriteria: z.array(z.string()).nullable().optional(),
    relations: z
      .array(
        z
          .object({
            kind: z.enum(relationKinds).default('blocks'),
            dependsOnId: z.uuid().optional(),
            blocksId: z.uuid().optional(),
            reason: z.string().max(2000).optional(),
            validUntil: z.iso.datetime().optional(),
          })
          .strict()
          .refine((r) => (r.dependsOnId == null) !== (r.blocksId == null), {
            message: 'each relation must set exactly one of dependsOnId or blocksId',
          }),
      )
      .max(20)
      .optional(),
    // cm:guard REQUIRED on any status write that enters `reopen` (RFC 0002 INV-8) — it is posted as a comment before the flip and is what the fix step scopes its patch against; `note` is accepted as a fallback so a caller that already explains itself there is not rejected
    reason: z.string().trim().min(1).max(10_000).optional(),
    // cm:guard say WHICH kind whenever you write `waiting` (RFC 0002 INV-5) — core never derives it, so an omitted kind leaves the board rendering "a human is needed" with no hint of what is being asked; it is cleared automatically on any exit
    waitingKind: z.enum(waitingKinds).optional(),
    // ISS-633 — plain label attach/detach. Accepts label NAMES or UUIDs,
    // resolved server-side (strict: unknown -> BAD_REQUEST, no auto-create).
    // REPLACE-SET semantics mirroring REST: this is the full desired label
    // set for the issue — [] clears all, undefined means "no change". Read
    // an issue's current `labels[]` (get/step_start) before sending a delta
    // to avoid clobbering the existing set.
    labels: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .strict();

// cm:edge contract -> packages/core/skills — the bundled skill markdown hand-writes `forge_issues → update → { data: { ... } }` payloads, and this object is `.strict()`, so a key named in a skill but absent here fails the whole call (the `status` write included) with a 400; `builtin-seed-field-names.test.ts` asserts the two sides agree.
export const ISSUE_UPDATE_DATA_KEYS = Object.keys(dataObject.shape);

const dataSchema = dataObject.optional();

/**
 * Heavy free-text fields — large TOAST bodies that dominate token count on
 * complex issues. When their total char count exceeds
 * STEP_START_BODY_MANIFEST_THRESHOLD in forge_step_start, they are replaced
 * by a manifest (field → {chars} | null) so agents can pull only the fields
 * they need via `forge_issues.get { fields: [...] }`.
 */
export const STEP_START_HEAVY_FIELDS = [
  'description',
  'plan',
  'acceptanceCriteria',
  'sessionContext',
] as const;

export type StepStartHeavyField = (typeof STEP_START_HEAVY_FIELDS)[number];

// Fields allowed in the get action's selective-projection param.
// Mirrors STEP_START_HEAVY_FIELDS (the body fields omitted in lean step_start)
// plus releaseNotes (small structured value sometimes worth fetching alone).
const GET_SELECTABLE_FIELDS = [...STEP_START_HEAVY_FIELDS, 'releaseNotes'] as const;

const inputSchema = z
  .object({
    action: z.enum([
      'list',
      'get',
      'create',
      'update',
      'transition',
      'createTask',
      'listTasks',
      'updateTask',
      'deleteTask',
      'mark_merged',
      'unmark',
    ]),
    projectId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: dataSchema,
    limit: z.number().int().min(1).max(500).optional(),
    /**
     * For action=get only: fetch only the listed fields (+ documentId/issueId)
     * instead of the full body. Useful when forge_step_start returned a lean
     * manifest (bodyTruncated:true) — the agent pulls only the fields it needs
     * rather than re-fetching the entire issue. Omitting this param is
     * backwards-compatible (returns full body with attachments[]).
     */
    fields: z.array(z.enum(GET_SELECTABLE_FIELDS)).min(1).max(20).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type IssueRow = {
  id: string;
  projectId: string;
  issSeq: number;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: string;
  category: string | null;
  reportedBy: string | null;
  complexity: string | null;
  assigneeId: string | null;
  createdById: string;
  reopenCount: number;
  source: string;
  externalId: string | null;
  plan: string | null;
  acceptanceCriteria: string | null;
  sessionContext: unknown;
  releaseNotes: ReleaseNotes | null;
  mergedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * ISS-532 — recursively char-strip control/invisible chars from every string
 * in an agent-authored JSON value (e.g. `sessionContext`). Defense-in-depth: a
 * runner agent wrote these, so DATA framing would be noise, but invisible-char
 * smuggling is still neutralized.
 */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeUntrusted(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeDeep(v)]),
    );
  }
  return value;
}

// cm:guard ISS-532 — human/external free-text reaching an agent must be framed by `markUntrusted`, never merely char-stripped: `sanitizeUntrusted` neutralizes invisible/bidi smuggling but does NOT tell the model the span is data, so a field promoted from agent-authored to human-authored and left on char-strip becomes an injection surface. REST/web-v2 serialize separately, so the human UI never shows the framing.
export function serialize(row: IssueRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    title: markUntrusted(row.title, { source: 'issue.title' }),
    description:
      row.description == null
        ? null
        : markUntrusted(row.description, { source: 'issue.description' }),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    plan: row.plan == null ? null : sanitizeUntrusted(row.plan),
    acceptanceCriteria:
      row.acceptanceCriteria == null
        ? null
        : markUntrusted(row.acceptanceCriteria, { source: 'issue.acceptanceCriteria' }),
    sessionContext: sanitizeDeep(row.sessionContext),
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Light projection type for the `list` surface — only the scalar fields that
 * `serializeListRow` actually reads. Using this instead of `IssueRow` lets the
 * SQL-level projection (db.select({...})) return a properly-typed result without
 * needing to load heavy TOAST columns from disk.
 */
type IssueListProjection = Pick<
  IssueRow,
  | 'id'
  | 'issSeq'
  | 'title'
  | 'status'
  | 'priority'
  | 'category'
  | 'complexity'
  | 'assigneeId'
  | 'reopenCount'
  | 'mergedAt'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * ISS-428 — body-free projection for the `list` (browse) surface. Returns only
 * light scalar fields and OMITS the heavy bodies (`description`, `plan`,
 * `acceptanceCriteria`, `sessionContext`, `releaseNotes`) so a list over many
 * populated issues never overflows the MCP
 * token cap. Heavy fields stay reachable per-issue via `action=get`. Do NOT
 * widen this back to `serialize()`.
 */

function serializeListRow(row: IssueListProjection): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    // ISS-532: char-strip only (NOT framed) — the browse-list projection exists
    // to stay under the MCP token cap (ISS-428); a full DATA banner per title
    // across many rows would defeat that. Invisible/bidi smuggling is still
    // neutralized.
    title: sanitizeUntrusted(row.title),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadIssue(documentId: string): Promise<IssueRow> {
  const [row] = await db.select().from(issues).where(eq(issues.id, documentId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row as IssueRow;
}

const LABEL_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * ISS-633 — tolerant name/uuid -> id resolver for the `list` filters.label
 * READ path. An unknown name is silently dropped (caller treats a fully-empty
 * result as "no issues match" rather than an error). NOT used for writes.
 */
async function resolveLabelIdsTolerant(projectId: string, rawValues: string[]): Promise<string[]> {
  const uuidValues = rawValues.filter((v) => LABEL_UUID_PATTERN.test(v));
  const nameValues = rawValues.filter((v) => !LABEL_UUID_PATTERN.test(v));

  let resolvedIds = [...uuidValues];
  if (nameValues.length > 0) {
    const nameRows = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.projectId, projectId), inArray(labels.name, nameValues)))
      .limit(nameValues.length + 1);
    resolvedIds = [...new Set([...resolvedIds, ...nameRows.map((r) => r.id)])];
  }
  return resolvedIds;
}

/**
 * ISS-633 — strict name/uuid -> id resolver for `forge_issues.update`/`create`
 * `data.labels` writes. Mirrors REST's `assertLabelsInProject` (issues/routes.ts)
 * but also resolves names. Every supplied value MUST resolve to a label that
 * belongs to `projectId` — an unknown name, an unknown uuid, or a uuid
 * belonging to another project all throw BAD_REQUEST. No auto-create.
 */
async function resolveLabelIdsForWrite(projectId: string, rawValues: string[]): Promise<string[]> {
  const uuidValues = [...new Set(rawValues.filter((v) => LABEL_UUID_PATTERN.test(v)))];
  const nameValues = [...new Set(rawValues.filter((v) => !LABEL_UUID_PATTERN.test(v)))];
  if (uuidValues.length === 0 && nameValues.length === 0) return [];

  const matchConds = [];
  if (uuidValues.length > 0) matchConds.push(inArray(labels.id, uuidValues));
  if (nameValues.length > 0) matchConds.push(inArray(labels.name, nameValues));

  const rows = await db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), or(...matchConds)))
    .limit(uuidValues.length + nameValues.length + 1);

  const foundIds = new Set(rows.map((r) => r.id));
  const foundNames = new Set(rows.map((r) => r.name));
  const missing = [
    ...uuidValues.filter((v) => !foundIds.has(v)),
    ...nameValues.filter((v) => !foundNames.has(v)),
  ];
  if (missing.length > 0) {
    throw new Error(
      `BAD_REQUEST: one or more labels do not exist in this project (no auto-create): ${missing.join(', ')}`,
    );
  }
  return [...foundIds];
}

/**
 * `serialize` + the issue's attachment metadata (`attachments[]`). Used by the
 * focused single-issue surfaces an agent acts on — `get`, the write-returns,
 * and `forge_step_start` (under-threshold path) — so the agent always sees
 * which files are attached (then reads bytes via `forge_uploads` action=fetch).
 * NOT used by `list` (summary/browse) to avoid an attachment query per row.
 */
export async function serializeWithAttachments(row: IssueRow): Promise<Record<string, unknown>> {
  const [attachments, issueLabelsList] = await Promise.all([
    listIssueAttachments(row.id),
    listIssueLabels(row.id),
  ]);
  return { ...serialize(row), attachments, labels: issueLabelsList };
}

// ── Lean manifest serializer for forge_step_start over-threshold path ──────

/** Sum of char lengths across all non-null heavy fields for threshold gating. */
export function heavyFieldChars(row: IssueRow): number {
  let total = 0;
  if (row.description != null) total += row.description.length;
  if (row.plan != null) total += row.plan.length;
  if (row.acceptanceCriteria != null) total += row.acceptanceCriteria.length;
  if (row.sessionContext != null) total += JSON.stringify(row.sessionContext).length;
  return total;
}

/**
 * Lean manifest — light scalars + `bodyManifest` (field → {chars} | null)
 * + `bodyTruncated: true`. Used by forge_step_start when heavy fields exceed
 * the threshold. Agents fetch fields they need via
 * `forge_issues.get { documentId, fields: ['plan', ...] }`.
 *
 * Heavy fields are NOT emitted — only their sizes. Title framing is preserved
 * (still needed for orientation). releaseNotes is a small scalar and remains
 * inline.
 */
export function serializeManifest(row: IssueRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    title: markUntrusted(row.title, { source: 'issue.title' }),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bodyTruncated: true as const,
    bodyManifest: {
      description: row.description != null ? { chars: row.description.length } : null,
      plan: row.plan != null ? { chars: row.plan.length } : null,
      acceptanceCriteria:
        row.acceptanceCriteria != null ? { chars: row.acceptanceCriteria.length } : null,
      sessionContext:
        row.sessionContext != null ? { chars: JSON.stringify(row.sessionContext).length } : null,
    },
  };
}

/** `serializeManifest` + attachment metadata. Used by forge_step_start over-threshold path. */
export async function serializeManifestWithAttachments(
  row: IssueRow,
): Promise<Record<string, unknown>> {
  const [attachments, issueLabelsList] = await Promise.all([
    listIssueAttachments(row.id),
    listIssueLabels(row.id),
  ]);
  return { ...serializeManifest(row), attachments, labels: issueLabelsList };
}

type TaskRow = {
  id: string;
  issueId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  isAgentTask: boolean;
  agentStatus: string | null;
  acceptanceCriteria: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function serializeTask(row: TaskRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    isAgentTask: row.isAgentTask,
    agentStatus: row.agentStatus,
    acceptanceCriteria: row.acceptanceCriteria,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Body-free projection for the `listTasks` surface — omits `description`
 * (up to 50KB each) so a list over many tasks never overflows the MCP token
 * cap. Full task body stays reachable via `action=updateTask` / `getTask`.
 * Do NOT widen this back to `serializeTask()` for the list path.
 */
function serializeTaskListRow(row: Omit<TaskRow, 'description'>): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    isAgentTask: row.isAgentTask,
    agentStatus: row.agentStatus,
    acceptanceCriteria: row.acceptanceCriteria,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

async function loadTaskForAccess(taskId: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: task not found');
  return row as TaskRow;
}

async function resolveProjectId(input: Input, ctx: McpContext): Promise<string> {
  return resolveEffectiveProjectId(ctx, input.projectId);
}

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`BAD_REQUEST: invalid ISO date for ${field}: ${value}`);
  }
  return d;
}

export const forgeIssuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_issues',
  description:
    'CRUD for project issues. Actions: list, get, create, update, transition, ' +
    'createTask, listTasks, updateTask, deleteTask, mark_merged, unmark. ' +
    'list returns a lightweight summary projection per issue (no description/' +
    'plan/acceptanceCriteria/sessionContext/releaseNotes) ' +
    'to stay under the response token cap; fetch the full body with action=get. ' +
    'list supports filters.label (a label name or uuid, or an array of either — ' +
    'OR semantics; unknown names return an empty set). ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'Token discipline: use list (projection) to browse/triage many issues, and ' +
    'get for the single full issue you are about to work on. When forge_step_start ' +
    'returned a lean manifest (bodyTruncated:true), pull only the fields you need ' +
    'via get with fields:[...] (e.g. { action:"get", documentId, fields:["plan"] }). ' +
    'Do NOT re-get an issue whose full body you already loaded this session. ' +
    'On create, fill title/description/priority/category — `plan` and ' +
    '`acceptanceCriteria` are written by the clarify/plan steps; pre-filling them ' +
    "deletes the plan step's reason to exist (red flag: plan-by-hand). Keep the " +
    'description a requirements contract (outcome, business rules, invariants, ' +
    'out-of-scope) — not an implementation script naming files, endpoints or ' +
    '"follow the pattern at <path>"; those claims go stale and outrank live ' +
    'exploration in practice. See guides pipeline-and-issue-lifecycle and writing-an-issue (body shape; mermaid fences render; ATTACH .html, never paste it into description). ' +
    'mark_merged (data.issueId + data.target<feature|base|prod> + optional ' +
    'data.mergedAt ISO + data.note) idempotently stamps issues.merged_at via ' +
    'COALESCE (a repeat call keeps the first timestamp), writes an audit ' +
    'comment, broadcasts the issue update, and wakes the dispatcher so a ' +
    'now-unblocked parent (blocks-gate) dispatches promptly. target is an ' +
    'audit label only — all values stamp the same merged_at column. unmark ' +
    '(data.issueId + optional data.note) clears merged_at back to NULL to ' +
    're-block children when an epic merge is rolled back. ' +
    'Transitioning an issue to closed auto-stamps merged_at when still NULL ' +
    '(closed = done for the blocks-gate); if a close meant "abandoned, code ' +
    'never landed", follow up with unmark to re-block dependents. ' +
    'Project scope is derived from the X-Forge-Project-Slug header (or an ' +
    'explicit projectId). Status changes route through the issue state machine. ' +
    'Use status:on_hold for a deliberate pause, or status:waiting to park an ' +
    'issue for human review. ' +
    'Attachments: for anything bigger than a tiny snippet use the forge_uploads tool ' +
    '(presigned-URL pattern) instead of base64 — base64 in data.attachments[] is slow ' +
    'and burns context tokens. Workflow: (1) create the issue to get its id; (2) call ' +
    'forge_uploads {action:"request", data:{target:"issue", targetId:<id>, name:"<file>"}} ' +
    '→ get an uploadUrl; (3) `curl -X PUT -T <localPath> "<uploadUrl>"` (no auth header). ' +
    'The PUT returns {id,name,mime,size,url}; reference the url in the body. ' +
    'data.attachments[] (base64-inline; up to 10, total ≤ UPLOADS_MAX_BYTES) still works ' +
    'for tiny inline files and on partial-failure returns `attachments` (succeeded) + ' +
    '`attachmentErrors` (code/message). ' +
    'Task sub-actions: createTask requires data.issueId + data.taskTitle; listTasks ' +
    'requires filters.issue and accepts filters.taskStatus; updateTask/deleteTask ' +
    'use documentId as the task UUID. Tasks inherit project membership from the ' +
    'parent issue. ' +
    'Relations (ISS-571, ISS-868): data.relations (optional array, max 20) is applied by ' +
    'BOTH create and update, and works with a personal access token — unlike ' +
    'forge_project_pm set_dependency, which needs a paired device. Edges commit before ' +
    'the dispatch trigger (issueCreated on create, the status transition on update), so ' +
    'the dispatcher cannot pick the issue up ahead of its blocker. Each entry takes kind ' +
    '(blocks|relates, default blocks) and exactly one of dependsOnId (THIS issue is ' +
    'blocked-by it) or blocksId (THIS issue blocks it). The response carries a relations[] ' +
    'array — one entry per edge with edgeId + created/updated — so you can tell the write ' +
    'landed; re-send an existing edge with validUntil in the past to RETRACT it ' +
    '(reported as updated:true). For decomposes edges, use forge_project_pm ' +
    'set_dependency kind=decomposes directly. Read edges back with action=get, which ' +
    'returns relations.blocks (this issue blocks them) and relations.blockedBy (they ' +
    'block this issue), each entry flagged `expired` when its validUntil has passed and ' +
    'the edge no longer gates dispatch. ' +
    'Labels (ISS-633): data.labels (create/update) accepts an array of label NAMES or ' +
    'UUIDs, resolved server-side against the current project — an unknown name/uuid ' +
    '(or one from another project) throws BAD_REQUEST; labels are never auto-created. ' +
    'On update this is a REPLACE-SET, NOT additive: it is the full desired label set for ' +
    'the issue — [] clears every label, and omitting data.labels leaves labels unchanged. ' +
    "Read the issue's current labels[] (present on get/create/update responses and the " +
    'forge_step_start bundle) before sending a delta, or you will clobber the existing set.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { device, principal } = ctx;

    // cm:guard `data` is ONE shared schema across all 11 actions, so a field only `create`/`update` apply is accepted and dropped by the other nine — refuse it by name here rather than returning 200 on a write that did nothing (ISS-868). `transition` is the dangerous one: it wakes considerEnqueue→dispatch, so a discarded `blocks` edge ships the dependent ahead of its blocker.
    if (
      input.data?.relations !== undefined &&
      input.action !== 'create' &&
      input.action !== 'update'
    ) {
      throw new Error(
        `BAD_REQUEST: data.relations is applied only by action 'create' and 'update' (got '${input.action}') — send the edges on the create/update call that carries them`,
      );
    }

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsMember(principal, projectId);

        const issuesLimit = input.limit ?? 25;
        const issuesEnvelope = {
          key: 'issues' as const,
          limit: issuesLimit,
          hint: 'add status/priority/category/label filters',
        };
        const conds = [eq(issues.projectId, projectId)];
        const f = input.filters;
        if (f?.status) conds.push(eq(issues.status, f.status));
        if (f?.statusNot) conds.push(ne(issues.status, f.statusNot));
        if (f?.priority) conds.push(eq(issues.priority, f.priority));
        if (f?.category) conds.push(eq(issues.category, f.category));
        if (f?.createdAfter) {
          conds.push(gte(issues.createdAt, parseDate(f.createdAfter, 'createdAfter')));
        }
        if (f?.createdBefore) {
          conds.push(lt(issues.createdAt, parseDate(f.createdBefore, 'createdBefore')));
        }
        if (f?.updatedAfter) {
          conds.push(gte(issues.updatedAt, parseDate(f.updatedAfter, 'updatedAfter')));
        }
        if (f?.search) {
          const q = `%${f.search}%`;
          const titleMatch = ilike(issues.title, q);
          const descMatch = ilike(issues.description, q);
          const orExpr = or(titleMatch, descMatch);
          if (orExpr) conds.push(orExpr);
        }

        if (f?.label !== undefined && f.label !== null) {
          const rawValues = Array.isArray(f.label) ? f.label : [f.label];
          const resolvedIds = await resolveLabelIdsTolerant(projectId, rawValues);

          if (resolvedIds.length === 0) {
            return buildListEnvelope({ ...issuesEnvelope, items: [] });
          }

          conds.push(
            exists(
              db
                .select({ one: sql`1` })
                .from(issueLabels)
                .where(
                  and(
                    eq(issueLabels.issueId, issues.id),
                    inArray(issueLabels.labelId, resolvedIds),
                  ),
                ),
            ),
          );
        }

        // ISS-562 — SQL-level light-column projection: never load heavy TOAST
        // columns (description/plan/acceptanceCriteria/sessionContext/ai*/
        // releaseNotes) from disk. serializeListRow already omits them at the
        // JS layer (ISS-428), but a bare db.select() still reads them from
        // Postgres. This aligns the DB query with the serializer projection.
        const rows = await db
          .select({
            id: issues.id,
            issSeq: issues.issSeq,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            category: issues.category,
            complexity: issues.complexity,
            assigneeId: issues.assigneeId,
            reopenCount: issues.reopenCount,
            mergedAt: issues.mergedAt,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(and(...conds))
          .orderBy(desc(issues.updatedAt))
          .limit(overfetch(issuesLimit));

        return buildListEnvelope({
          ...issuesEnvelope,
          items: rows.map((r) => serializeListRow(r)),
        });
      }

      case 'get': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for get');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsMember(principal, issue.projectId);
        if (input.fields && input.fields.length > 0) {
          // Field-selective projection: pick from the already-framed serialize()
          // output so markUntrusted DATA banners are preserved on untrusted fields
          // (description/acceptanceCriteria). Never project from the raw row.
          const full = serialize(issue);
          const projected: Record<string, unknown> = {
            documentId: full.documentId,
            issueId: full.issueId,
          };
          for (const field of input.fields) {
            projected[field] = full[field] ?? null;
          }
          return projected;
        }
        // cm:edge contract -> packages/core/src/issues/dependency-read.ts — the ONLY read path an agent has onto its own edges; REST GET /api/issues/:id/dependencies is JWT-only, so without this a token that can write an edge still cannot verify one landed
        const [full, relations] = await Promise.all([
          serializeWithAttachments(issue),
          loadIssueRelations(issue.id, issue.projectId),
        ]);
        return { ...full, relations };
      }

      case 'create': {
        if (!input.data?.title) throw new Error('BAD_REQUEST: data.title is required for create');
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsWriter(principal, projectId);

        // ISS-130 — narrow allow-list for entry status. `open` is the normal
        // triage entry, `on_hold` is the decomposition parking state, and
        // ISS-236 adds `draft` for AI-generated proposals that wait for human
        // promote/discard before entering the pipeline. Anything else must go
        // through the transition action so the state machine + activity log run.
        const requestedStatus: IssueStatus = input.data.status ?? 'open';
        if (
          requestedStatus !== 'open' &&
          requestedStatus !== 'on_hold' &&
          requestedStatus !== 'draft'
        ) {
          throw new Error(
            `BAD_REQUEST: status at create must be 'open', 'on_hold', or 'draft' (got '${requestedStatus}'); use the transition action for other statuses`,
          );
        }

        // ISS-606: a gated project parks every would-be `open` create at draft.
        const intake = await applyIntakeGate(projectId, requestedStatus);
        const createStatus = intake.status;

        // Decode + size-cap attachments BEFORE insert so a bad payload doesn't
        // leave a half-created issue with no files.
        let decodedAttachments: DecodedAttachment[] = [];
        if (input.data.attachments && input.data.attachments.length > 0) {
          try {
            decodedAttachments = decodeAndValidateAttachments(input.data.attachments);
          } catch (err) {
            if (err instanceof AttachmentError) {
              throw new Error(`${err.code}: ${err.message}`);
            }
            throw err;
          }
        }

        // ISS-633 — resolve + strictly validate label names/uuids BEFORE
        // insert (same "fail before half-created" discipline as attachments).
        let labelIds: string[] = [];
        if (input.data.labels && input.data.labels.length > 0) {
          labelIds = await resolveLabelIdsForWrite(projectId, input.data.labels);
        }

        // cm:guard one live issue per detector — a recurring finding must land on the issue already tracking it, never as issue N+1
        const detectorKey = input.data.detectorKey ?? null;
        if (detectorKey) {
          if (!isValidDetectorKey(detectorKey)) {
            throw new Error(
              `BAD_REQUEST: data.detectorKey must be lowercase slash-separated slugs, max 120 chars (got '${detectorKey}')`,
            );
          }
          const { existingIssueId } = await claimDetectorKey(projectId, detectorKey);
          if (existingIssueId) {
            const [live] = await db
              .select({ issSeq: issues.issSeq, status: issues.status })
              .from(issues)
              .where(eq(issues.id, existingIssueId))
              .limit(1);
            return {
              created: false,
              deduped: true,
              detectorKey,
              existingIssueId,
              existingIssueDisplayId: live ? `ISS-${live.issSeq}` : null,
              existingIssueStatus: live?.status ?? null,
              message:
                'A live issue already tracks this detectorKey. Nothing was created — add your finding as a comment on existingIssueId (forge_comments action=create), or extend it via forge_issues action=update.',
            } as Record<string, unknown>;
          }
        }

        const [inserted] = await db
          .insert(issues)
          .values({
            projectId,
            title: input.data.title,
            description: input.data.description ?? null,
            status: createStatus,
            priority: input.data.priority ?? 'medium',
            category: input.data.category ?? null,
            complexity: input.data.complexity ?? null,
            createdById: device.ownerId,
            createdVia: 'mcp',
            detectorKey,
            plan: input.data.plan ?? null,
            acceptanceCriteria: input.data.acceptanceCriteria ?? null,
            sessionContext: input.data.sessionContext ?? null,
            releaseNotes: input.data.releaseNotes ?? null,
          })
          .returning();
        if (!inserted) throw new Error('issues: insert returned no row');

        const created = inserted as IssueRow;

        // ISS-633 — attach labels (REST parity: issues/routes.ts ~284-288).
        if (labelIds.length > 0) {
          await db
            .insert(issueLabels)
            .values(labelIds.map((labelId) => ({ issueId: created.id, labelId })));
        }

        // ISS-606: label + owner notification for a gated (parked) create.
        if (intake.gated) await finalizeIntake(projectId, { id: created.id, title: created.title });

        // cm:edge ordering -> packages/core/src/jobs/dispatch-gates.ts — the edges MUST commit before the issueCreated emit below, which synchronously triggers considerEnqueue→dispatch; an edge written after it is invisible to the L2 blocks-gate on the first tick and the dependent ships ahead of its blocker
        const r = await applyIssueRelations(ctx, projectId, created.id, input.data.relations);

        await hooks.emit('issueCreated', {
          issueId: created.id,
          projectId: created.projectId,
          actor: { type: 'device' as const, id: device.id },
          status: created.status,
          snapshot: {
            title: created.title,
            description: created.description,
            priority: created.priority,
            category: created.category,
            reportedBy: created.reportedBy,
            assigneeId: created.assigneeId,
            labels: labelIds,
          },
        });

        const result: Record<string, unknown> = serialize(created);
        result.labels = labelIds.length > 0 ? await listIssueLabels(created.id) : [];
        if (r.length > 0) result.relations = r;
        if (decodedAttachments.length > 0) {
          const { persisted, errors } = await persistDecodedIssueAttachments(
            created.id,
            decodedAttachments,
            device.ownerId,
          );
          result.attachments = persisted;
          if (errors.length > 0) result.attachmentErrors = errors;
        }
        return result;
      }

      case 'update': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for update');
        if (!input.data) throw new Error('BAD_REQUEST: data is required for update');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // ISS-633 — resolve + strictly validate label names/uuids BEFORE the
        // tx (mirrors REST PATCH's assertLabelsInProject running before its
        // own tx). `undefined` means "no change"; `[]` clears every label.
        const labelIds =
          input.data.labels !== undefined
            ? await resolveLabelIdsForWrite(issue.projectId, input.data.labels)
            : undefined;

        if (input.data.detectorKey !== undefined && !isValidDetectorKey(input.data.detectorKey)) {
          throw new Error(
            `BAD_REQUEST: data.detectorKey must be lowercase slash-separated slugs, max 120 chars (got '${input.data.detectorKey}')`,
          );
        }

        // Shared whitelist (issues/patch-fields.ts) — same plain columns as
        // REST PATCH plus the MCP-only agent-facing fields.
        const updates = collectIssueFieldUpdates(input.data as Record<string, unknown>, [
          ...SHARED_ISSUE_PATCH_FIELDS,
          ...MCP_ONLY_ISSUE_PATCH_FIELDS,
        ]);

        // cm:edge ordering -> packages/core/src/issues/transition-evidence.ts — field writes MUST commit before the status transition below, which re-reads issues.plan for PLAN_REQUIRED; reversed order throws PLAN_REQUIRED on a legal { plan, status:'approved' } call and discards the submitted plan
        // cm:edge ordering -> packages/core/src/issues/release-record-required.ts — the second reader of this order, and the reason a close needs one call rather than two: that rule re-reads issues.release_notes, so a reversed order throws RELEASE_RECORD_REQUIRED on a legal { releaseNotes, status:'closed' } and discards the note the caller just wrote to satisfy it
        if (Object.keys(updates).length > 0 || labelIds !== undefined) {
          // cm:why sql`now()`, matching transitionIssueStatus below — a combined status+fields update needs one canonical timestamp source, not a mix of JS Date and DB now()
          updates.updatedAt = sql`now()`;
          const actor = { type: 'device' as const, id: device.id };
          await db.transaction(async (tx) => {
            await tx.update(issues).set(updates).where(eq(issues.id, issue.id));

            // ISS-633 — replace-set label delta, in-tx (rolls back together
            // with the field update on failure) with issue.labeled/unlabeled
            // activity, matching REST PATCH (issues/routes.ts ~609-645).
            if (labelIds !== undefined) {
              const existing = await tx
                .select({ labelId: issueLabels.labelId })
                .from(issueLabels)
                .where(eq(issueLabels.issueId, issue.id))
                .limit(500);
              const oldSet = new Set(existing.map((r) => r.labelId));
              const newSet = new Set(labelIds);
              const labelsAdded = [...newSet].filter((l) => !oldSet.has(l));
              const labelsRemoved = [...oldSet].filter((l) => !newSet.has(l));

              await tx.delete(issueLabels).where(eq(issueLabels.issueId, issue.id));
              if (labelIds.length > 0) {
                await tx
                  .insert(issueLabels)
                  .values(labelIds.map((labelId) => ({ issueId: issue.id, labelId })));
              }

              for (const labelId of labelsAdded) {
                await recordActivityTx(tx, {
                  issueId: issue.id,
                  actor,
                  action: 'issue.labeled',
                  payload: { labelId },
                });
              }
              for (const labelId of labelsRemoved) {
                await recordActivityTx(tx, {
                  issueId: issue.id,
                  actor,
                  action: 'issue.unlabeled',
                  payload: { labelId },
                });
              }
            }
          });
        }

        // cm:edge ordering -> packages/core/src/jobs/dispatch-gates.ts — relations commit BEFORE the transition below, for the same reason create commits them before issueCreated: the transition is what wakes considerEnqueue→dispatch, so a blocks edge written after it misses the first tick and the dependent ships ahead of its blocker. This order is also the SAFE side of a partial failure, which is why the two writes are deliberately not one transaction: edges landed + transition failed leaves an extra `blocks` edge holding a job, which a human can retract, where the reverse ships a dependent ahead of its blocker and cannot be undone.
        const r = await applyIssueRelations(ctx, issue.projectId, issue.id, input.data.relations);

        if (input.data.status && input.data.status !== issue.status) {
          await transitionIssueStatus(issue, input.data.status, principalActor(principal, device), {
            transitionReason: input.data.reason ?? input.data.note,
            waitingKind: input.data.waitingKind,
          });
        }

        const fresh = await loadIssue(issue.id);
        // cm:guard report what the call DID under `action`, matching mark_merged/unmark below — this used to return the literal `status:'updated'` over the issue's own status enum, so a caller could not read back the status it had just written, and `relations` was parsed and silently discarded (ISS-868)
        const updateResult: Record<string, unknown> = {
          ...(await serializeWithAttachments(fresh)),
          action: 'updated',
        };
        if (r.length > 0) updateResult.relations = r;
        return updateResult;
      }

      case 'transition': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId is required for transition');
        }
        const target = input.data?.status;
        if (!target) throw new Error('BAD_REQUEST: data.status is required for transition');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsWriter(principal, issue.projectId);
        await transitionIssueStatus(issue, target, principalActor(principal, device), {
          transitionReason: input.data?.reason ?? input.data?.note,
          waitingKind: input.data?.waitingKind,
        });
        const fresh = await loadIssue(issue.id);
        const transitionOutput: Record<string, unknown> = await serializeWithAttachments(fresh);
        return transitionOutput;
      }

      // ISS-286 — explicit, idempotent, auditable merge-marker. Decouples
      // `merged_at` from the implicit `markMergedIfLeavingBase` side-effect so
      // a skill can stamp the merge directly after verifying a push (epic /
      // feature-branch barrier: a `blocks` parent is gated on every child's
      // `merged_at IS NOT NULL` — see jobs/dispatch-gates.ts blockedBy).
      case 'mark_merged': {
        const issueId = input.data?.issueId;
        if (!issueId) {
          throw new Error('BAD_REQUEST: data.issueId is required for mark_merged');
        }
        const target = input.data?.target;
        if (!target) {
          throw new Error('BAD_REQUEST: data.target is required for mark_merged');
        }
        const issue = await loadIssue(issueId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // ISS-786 child B (ISS-75/76/77/78 shape) — a device-principal claim
        // of "this is merged" needs the same in-DB evidence `developed`/
        // `testing` require. A `user`-driven PAT is a deliberate human
        // action and is NOT gated (mirrors `checkTransitionEvidence`'s
        // device-only scope). Fails OPEN on any internal error.
        if (principal.kind === 'device') {
          const missingEvidence = await findMissingWorkEvidence(issueId);
          if (missingEvidence) {
            throw new Error(`NO_WORK_EVIDENCE: ${missingEvidence}`);
          }
        }

        // COALESCE keeps the first stamp: a second mark_merged call is a no-op
        // on the timestamp (AC2 idempotency). `mergedAt` overrides the default
        // server `now()`. `target` is an audit label only — trunk-based v2 has
        // a single merge column (no `merged_to_prod_at` until v3).
        const stamp = input.data?.mergedAt ? parseDate(input.data.mergedAt, 'mergedAt') : null;
        // Bind the explicit stamp as an ISO string with a `::timestamptz`
        // cast. A bare `sql`${date}`` binds an untyped parameter, and Postgres
        // cannot infer its type inside COALESCE("merged_at", $1) — it errors
        // "could not determine data type of parameter" (live 500 on forge-beta
        // for the mergedAt-supplied path). The cast pins the type.
        const stampExpr = stamp ? sql`${stamp.toISOString()}::timestamptz` : sql`now()`;
        await db
          .update(issues)
          .set({ mergedAt: sql`COALESCE(${issues.mergedAt}, ${stampExpr})`, updatedAt: sql`now()` })
          .where(eq(issues.id, issueId));

        const body = `mark_merged target=${target}${input.data?.note ? ` — ${input.data.note}` : ''}`;
        // cm:guard ISS-820 — this is an automated MCP-surface audit comment; isAi:true or it reads as a human answer and can release a needs_info bounce
        const [auditComment] = await db
          .insert(comments)
          .values({ issueId, authorId: device.ownerId, body, parentId: null, isAi: true })
          .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
        if (auditComment) {
          await hooks.emit('commentCreated', {
            issueId,
            projectId: issue.projectId,
            actor: principalHookActor(principal, device),
            commentId: auditComment.id,
            body: auditComment.body,
            parentId: auditComment.parentId,
          });
        }

        const fresh = await loadIssue(issueId);
        await hooks.emit('issueUpdated', {
          issueId,
          projectId: issue.projectId,
          actor: principalHookActor(principal, device),
          fields: ['mergedAt'],
          before: { mergedAt: issue.mergedAt },
          after: { mergedAt: fresh.mergedAt },
        });
        // Wake the dispatcher so a now-unblocked parent dispatches within ~1s
        // instead of waiting for the 60s pg-boss backstop (AC3).
        void dispatchTickForProject(issue.projectId);

        // cm:guard report the ACTION under `action`, never by overwriting `status` — `merged`/`unmarked`
        //   are not `issueStatuses` members, so a caller read a lifecycle value that cannot exist (§10)
        return { ...(await serializeWithAttachments(fresh)), action: 'merged' };
      }

      case 'unmark': {
        const issueId = input.data?.issueId;
        if (!issueId) {
          throw new Error('BAD_REQUEST: data.issueId is required for unmark');
        }
        const issue = await loadIssue(issueId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // Clearing `merged_at` re-blocks downstream children (AC4 — supports
        // rolling back an epic whose merge was reverted).
        await db
          .update(issues)
          .set({ mergedAt: null, updatedAt: sql`now()` })
          .where(eq(issues.id, issueId));

        const body = `unmark${input.data?.note ? ` — ${input.data.note}` : ''}`;
        // cm:guard ISS-820 — automated MCP-surface audit comment; isAi:true so it can't release a needs_info bounce
        const [auditComment] = await db
          .insert(comments)
          .values({ issueId, authorId: device.ownerId, body, parentId: null, isAi: true })
          .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
        if (auditComment) {
          await hooks.emit('commentCreated', {
            issueId,
            projectId: issue.projectId,
            actor: principalHookActor(principal, device),
            commentId: auditComment.id,
            body: auditComment.body,
            parentId: auditComment.parentId,
          });
        }

        const fresh = await loadIssue(issueId);
        await hooks.emit('issueUpdated', {
          issueId,
          projectId: issue.projectId,
          actor: principalHookActor(principal, device),
          fields: ['mergedAt'],
          before: { mergedAt: issue.mergedAt },
          after: { mergedAt: null },
        });
        // No dispatcher tick: clearing only adds a block, never unblocks.

        return { ...(await serializeWithAttachments(fresh)), action: 'unmarked' };
      }

      case 'listTasks': {
        const issueId = input.filters?.issue;
        if (!issueId) throw new Error('BAD_REQUEST: filters.issue required for listTasks');
        const projectId = await loadIssueProjectId(issueId);
        await assertPrincipalIsMember(principal, projectId);

        const where = input.filters?.taskStatus
          ? and(eq(tasks.issueId, issueId), eq(tasks.status, input.filters.taskStatus))
          : eq(tasks.issueId, issueId);

        const tasksLimit = input.limit ?? 25;
        // ISS-562 — SQL-level projection: omit description (up to 50KB each)
        // so the list query never loads heavy TOAST content from disk. Default
        // limit lowered 100→25 (100 tasks × 50KB = 5MB theoretical max).
        const rows = await db
          .select({
            id: tasks.id,
            issueId: tasks.issueId,
            projectId: tasks.projectId,
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            assigneeId: tasks.assigneeId,
            isAgentTask: tasks.isAgentTask,
            agentStatus: tasks.agentStatus,
            acceptanceCriteria: tasks.acceptanceCriteria,
            createdAt: tasks.createdAt,
            updatedAt: tasks.updatedAt,
          })
          .from(tasks)
          .where(where)
          .orderBy(asc(tasks.createdAt))
          .limit(overfetch(tasksLimit));

        return buildListEnvelope({
          key: 'tasks',
          items: rows.map((r) => serializeTaskListRow(r)),
          limit: tasksLimit,
          hint: 'filter by taskStatus, or fetch tasks individually',
          order: 'asc',
        });
      }

      case 'createTask': {
        const data = input.data;
        if (!data?.issueId) throw new Error('BAD_REQUEST: data.issueId required for createTask');
        if (!data.taskTitle) throw new Error('BAD_REQUEST: data.taskTitle required for createTask');
        const projectId = await loadIssueProjectId(data.issueId);
        await assertPrincipalIsWriter(principal, projectId);

        const [created] = await db
          .insert(tasks)
          .values({
            issueId: data.issueId,
            projectId,
            title: data.taskTitle,
            description: data.taskDescription ?? null,
            status: data.taskStatus ?? 'backlog',
            priority: data.taskPriority ?? 'none',
            isAgentTask: data.isAgentTask ?? false,
            acceptanceCriteria: data.taskAcceptanceCriteria ?? null,
          })
          .returning();

        return { task: serializeTask(created as TaskRow) };
      }

      case 'updateTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for updateTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);

        const data = input.data ?? {};
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (data.taskTitle !== undefined) updates.title = data.taskTitle;
        if (data.taskDescription !== undefined) updates.description = data.taskDescription;
        if (data.taskStatus !== undefined) updates.status = data.taskStatus;
        if (data.taskPriority !== undefined) updates.priority = data.taskPriority;
        if (data.isAgentTask !== undefined) updates.isAgentTask = data.isAgentTask;
        if (data.taskAcceptanceCriteria !== undefined) {
          updates.acceptanceCriteria = data.taskAcceptanceCriteria;
        }

        const [updated] = await db
          .update(tasks)
          .set(updates)
          .where(eq(tasks.id, input.documentId))
          .returning();

        return { task: serializeTask(updated as TaskRow) };
      }

      case 'deleteTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for deleteTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);
        await db.delete(tasks).where(eq(tasks.id, input.documentId));
        return { deleted: true, documentId: input.documentId };
      }
    }
  },
});
