// A verdict a run sends again, word for word (adminhub-fe ISS-51, 2026-10-26: criterion 1 posted
// twice by one run session, 6 s apart, with identical content, written as two rows). A run's verdict
// identical to that run's latest on the criterion is the same verdict sent twice, as a retry after
// a lost answer does: the door answers the row it already holds, `duplicate: true`, and writes
// nothing. Only a run session's verdict is matched; a person's or an unnamed box's is written.

import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { criterionProbes, criterionVerdicts } from '../../db/schema-issue-criteria.js';
import type { VerdictDraft } from './verdict-input.js';

type VerdictColumns = Partial<typeof criterionVerdicts.$inferInsert>;

/** The identity columns a draft writes, compared as stored: one judged against another identity is new. */
const IDENTITY_KEYS = [
  'identityKind',
  'commitSha',
  'runtimeRef',
  'designWorkflowId',
  'designRevision',
  'contractRef',
  'contractVersion',
  'storefrontEnvironment',
] as const satisfies ReadonlyArray<keyof VerdictColumns>;

/** JSON with its object keys sorted, so two equal values compare equal whatever order they were sent in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The id of `runSessionId`'s latest verdict on the criterion where this one repeats it: the same
 * verdict, identity, reason, evidence and judge, and the same probe where one is sent. Null where the
 * run has none, where its latest differs in any of them, or where no run session records it.
 */
export async function repeatedVerdict(
  tx: Tx,
  args: {
    criterionId: string;
    runSessionId: string | null;
    draft: Pick<VerdictDraft, 'verdict' | 'reason' | 'evidence' | 'probe'>;
    identity: VerdictColumns;
    judge: string;
  },
): Promise<string | null> {
  if (!args.runSessionId) return null;
  const sent = {
    verdict: args.draft.verdict,
    reason: args.draft.reason?.trim() || null,
    evidence: args.draft.evidence,
    probe: args.draft.probe ?? null,
  };
  const [latest] = await tx
    .select()
    .from(criterionVerdicts)
    .where(
      and(
        eq(criterionVerdicts.criterionId, args.criterionId),
        eq(criterionVerdicts.runSessionId, args.runSessionId),
      ),
    )
    .orderBy(desc(criterionVerdicts.createdAt), desc(criterionVerdicts.id))
    .limit(1);
  if (!latest) return null;
  if (latest.verdict !== sent.verdict || (latest.reason ?? null) !== sent.reason) return null;
  if (latest.judge !== args.judge) return null;
  if (canonical(latest.evidence) !== canonical([...sent.evidence])) return null;
  for (const key of IDENTITY_KEYS) {
    if ((latest[key] ?? null) !== (args.identity[key] ?? null)) return null;
  }
  if (canonical(latest.storefrontDrafts) !== canonical(args.identity.storefrontDrafts ?? null)) {
    return null;
  }
  if (sent.probe != null) {
    if (!latest.probeId) return null;
    const [kept] = await tx
      .select({ spec: criterionProbes.spec })
      .from(criterionProbes)
      .where(eq(criterionProbes.id, latest.probeId))
      .limit(1);
    if (!kept || canonical(kept.spec) !== canonical(sent.probe)) return null;
  }
  return latest.id;
}
