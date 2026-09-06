import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, type LabelKind, labels } from '../db/schema.js';

// cm:edge contract -> packages/contracts/src/rows.ts — `ModuleAttribution` is this shape under the name a client reads it by; `kind` is what lets that client tell a module from a label without a second call, and `isPrimary` is the attribution itself.
export type IssueLabelLite = {
  id: string;
  name: string;
  color: string;
  kind: LabelKind;
  isPrimary: boolean;
};

/**
 * ISS-593 — one item of a `labels[]` write. The bare string is the pre-existing form and still
 * means "attach this label, not primary"; the object form is the only way to designate the
 * issue's primary module. `labelId` accepts a NAME or a uuid, exactly as the string form does —
 * one resolver, so the two arms can never disagree about what a value means.
 */
export type LabelAttachInput = string | { labelId: string; isPrimary?: boolean | undefined };

/** A resolved junction row, ready to insert. */
export type ResolvedLabelAttach = { labelId: string; isPrimary: boolean };

/**
 * ISS-633 — an issue's current labels. Used by the MCP focused single-issue
 * serializers (`serializeWithAttachments` / `serializeManifestWithAttachments`
 * in mcp/tools/forge-issues.ts) so a skill can read-then-replace `data.labels`
 * without clobbering the existing set. Kept in its own module (mirroring
 * `listIssueAttachments` in attachment-service.ts) so it can be mocked
 * independently of the generic `db.select` chain in tests.
 */
export async function listIssueLabels(issueId: string): Promise<IssueLabelLite[]> {
  return db
    .select({
      id: labels.id,
      name: labels.name,
      color: labels.color,
      kind: labels.kind,
      isPrimary: issueLabels.isPrimary,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(eq(issueLabels.issueId, issueId));
}

// cm:guard carry the missing VALUES, not a message — REST answers 400 `INVALID_LABELS` and MCP answers a `BAD_REQUEST: …` string naming each unresolved label, and both are asserted; a shared message rewrites one caller's contract
export class LabelResolutionError extends Error {
  constructor(readonly missing: string[]) {
    super('INVALID_LABELS');
    this.name = 'LabelResolutionError';
  }
}

// cm:guard the write path (`resolveLabelIdsForWrite`) and the tolerant read path (`resolveLabelIdsTolerant`) MUST split their input on THIS regex — they differ only in throw-vs-drop, so a second copy lets one treat a value as an id while the other treats it as a label name, silently creating a label nobody asked for. ISS-889 forked it once already; both now live in this file so the fork cannot recur across a module boundary.
export const LABEL_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * ISS-633 — strict name/uuid -> id resolver for `data.labels` WRITES. Every
 * supplied value MUST resolve to a label that belongs to `projectId` — an
 * unknown name, an unknown uuid, or a uuid belonging to another project all
 * throw. No auto-create.
 *
 * ISS-593 — it also resolves the primary-module designation, and refuses the two shapes the
 * database cannot: a primary that is a plain label, and a set with more than one primary.
 * Both throw HERE, outside the transaction, exactly as an unresolved label does.
 */
// cm:why resolves names as well as uuids so an agent can write `labels:['bug']` without a lookup round trip; the tolerant READ-path resolver below drops unknowns instead, and the two must not be swapped
export async function resolveLabelIdsForWrite(
  projectId: string,
  rawValues: readonly LabelAttachInput[],
): Promise<ResolvedLabelAttach[]> {
  const items = rawValues.map((v) =>
    typeof v === 'string'
      ? { labelId: v, isPrimary: false }
      : { labelId: v.labelId, isPrimary: v.isPrimary === true },
  );

  const primaries = items.filter((i) => i.isPrimary);
  if (primaries.length > 1) {
    throw new PrimaryModuleError(
      'MULTIPLE_PRIMARY',
      `an issue has at most one primary module; this set marks ${primaries.length}`,
    );
  }

  const uuidValues = [
    ...new Set(items.map((i) => i.labelId).filter((v) => LABEL_UUID_PATTERN.test(v))),
  ];
  const nameValues = [
    ...new Set(items.map((i) => i.labelId).filter((v) => !LABEL_UUID_PATTERN.test(v))),
  ];
  if (uuidValues.length === 0 && nameValues.length === 0) return [];

  const matchConds = [];
  if (uuidValues.length > 0) matchConds.push(inArray(labels.id, uuidValues));
  if (nameValues.length > 0) matchConds.push(inArray(labels.name, nameValues));

  const rows = await db
    .select({ id: labels.id, name: labels.name, kind: labels.kind })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), or(...matchConds)))
    .limit(uuidValues.length + nameValues.length + 1);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const byName = new Map(rows.map((r) => [r.name, r]));
  const missing = [
    ...uuidValues.filter((v) => !byId.has(v)),
    ...nameValues.filter((v) => !byName.has(v)),
  ];
  if (missing.length > 0) throw new LabelResolutionError(missing);

  // cm:guard de-duplicate on the RESOLVED id, not on the raw value — a set naming the same label once by name and once by uuid would otherwise insert two rows and violate the junction's composite primary key at commit, turning a caller's typo into a 500.
  const resolved = new Map<string, boolean>();
  for (const item of items) {
    const row = byId.get(item.labelId) ?? byName.get(item.labelId);
    if (!row) continue;
    if (item.isPrimary && row.kind !== 'module') {
      throw new PrimaryModuleError(
        'PRIMARY_NOT_MODULE',
        `only a module can be an issue's primary: ${row.name} is a label`,
      );
    }
    resolved.set(row.id, (resolved.get(row.id) ?? false) || item.isPrimary);
  }
  return [...resolved].map(([labelId, isPrimary]) => ({ labelId, isPrimary }));
}

// cm:guard a distinct class from LabelResolutionError because the two map to different HTTP codes and different MCP prefixes — folding them loses which half of the write was wrong, and `INVALID_LABELS` carries a `missing[]` these have nothing to put in.
export class PrimaryModuleError extends Error {
  constructor(
    readonly code: 'PRIMARY_NOT_MODULE' | 'MULTIPLE_PRIMARY',
    message: string,
  ) {
    super(message);
    this.name = 'PrimaryModuleError';
  }
}

/**
 * ISS-633 — tolerant name/uuid -> id resolver for the `list` filters.label
 * READ path. An unknown name is silently dropped (the caller treats a
 * fully-empty result as "no issues match" rather than an error). NOT for
 * writes: `resolveLabelIdsForWrite` above throws on the same input.
 */
export async function resolveLabelIdsTolerant(
  projectId: string,
  rawValues: readonly string[],
): Promise<string[]> {
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
 * ISS-593 — tolerant module name|uuid -> id resolver for the `module` READ filter. Same
 * throw-free contract as `resolveLabelIdsTolerant`, and the same uuid/name split, but
 * constrained to `kind='module'`: the name of a plain label resolves to nothing, so filtering
 * by it returns no issues rather than quietly behaving as `label`.
 */
export async function resolveModuleIdsTolerant(
  projectId: string,
  rawValues: readonly string[],
): Promise<string[]> {
  const uuidValues = rawValues.filter((v) => LABEL_UUID_PATTERN.test(v));
  const nameValues = rawValues.filter((v) => !LABEL_UUID_PATTERN.test(v));
  if (uuidValues.length === 0 && nameValues.length === 0) return [];

  const matchConds = [];
  if (uuidValues.length > 0) matchConds.push(inArray(labels.id, uuidValues));
  if (nameValues.length > 0) matchConds.push(inArray(labels.name, nameValues));

  // cm:guard the `kind='module'` predicate is the whole point — without it this is `resolveLabelIdsTolerant` under another name, and `?module=bug` would filter on the plain label `bug` while the caller reads the result as a module's issues.
  const rows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module'), or(...matchConds)))
    .limit(uuidValues.length + nameValues.length + 1);
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * ISS-594 — every issue's module attributions, for a page of issues at once.
 *
 * The list surface needs the primary module per row, and the search response carries no labels at
 * all; a per-row read of `listIssueLabels` would be one request per row. Modules only: a plain
 * label on the same junction is not an attribution and the list has no column for it.
 */
// cm:edge contract -> packages/contracts/src/rows.ts — this IS `ModuleAttribution`, re-declared rather than imported because `@forge/contracts` depends on `@forge/core` and not the other way round; a field added there and not here reaches no client
export type ModuleAttribution = {
  labelId: string;
  name: string;
  color: string;
  isPrimary: boolean;
};

export async function listModulesForIssues(
  issueIds: readonly string[],
): Promise<Map<string, ModuleAttribution[]>> {
  const out = new Map<string, ModuleAttribution[]>();
  if (issueIds.length === 0) return out;

  const rows = await db
    .select({
      issueId: issueLabels.issueId,
      labelId: labels.id,
      name: labels.name,
      color: labels.color,
      isPrimary: issueLabels.isPrimary,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(and(inArray(issueLabels.issueId, [...issueIds]), eq(labels.kind, 'module')));

  // cm:guard the primary sorts first within each issue — the list cell renders `modules[0]`, so an
  // issue whose secondary happened to come back first would show the wrong module as its primary.
  for (const r of rows) {
    const list = out.get(r.issueId) ?? [];
    const entry = { labelId: r.labelId, name: r.name, color: r.color, isPrimary: r.isPrimary };
    if (r.isPrimary) list.unshift(entry);
    else list.push(entry);
    out.set(r.issueId, list);
  }
  return out;
}
