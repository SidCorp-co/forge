import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, labels } from '../db/schema.js';

export type IssueLabelLite = { id: string; name: string; color: string };

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
    .select({ id: labels.id, name: labels.name, color: labels.color })
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
 */
// cm:why resolves names as well as uuids so an agent can write `labels:['bug']` without a lookup round trip; the tolerant READ-path resolver (forge-issues.ts) drops unknowns instead, and the two must not be swapped
export async function resolveLabelIdsForWrite(
  projectId: string,
  rawValues: readonly string[],
): Promise<string[]> {
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
  if (missing.length > 0) throw new LabelResolutionError(missing);
  return [...foundIds];
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
