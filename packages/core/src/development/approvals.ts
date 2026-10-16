/**
 * The approval inbox (`@forge/contracts/approvals`): every pending record of one project waiting on
 * the viewer's approve-type decision. A requirement revision, an agreement, a release and a design
 * come from the needs-me classification (`needs-you-decisions.ts:decisionsOf`), so a row here is the
 * same decision the home and the chat show, with the same buttons; suggestions, mockups and issue
 * previews come from their owners' reads, each kept only where the viewer may decide it. Who asked
 * is read from the record that asked, never guessed: a row whose record keeps nobody says so.
 *
 * A row is titled by its record's short title, cut at a whole word to the row's bound
 * (`@forge/contracts/approvals:approvalTitle`), never by a prose field. A record no row can be made
 * of is carried by name in `unreadable` and logged; the rest of the inbox still answers
 * (`approvals-rows.ts:inboxRowsOf`).
 */

import {
  APPROVAL_INBOX_MAX,
  type ApprovalInbox,
  approvalInboxSchema,
  byWaitedLongest,
} from '@forge/contracts/approvals';
import type { ProjectAccess } from '../lib/authz.js';
import { peopleOf } from '../lib/people.js';
import { waitingMockupsAs } from '../mockups/read.js';
import { holds } from '../permissions/index.js';
import { approvablePreviewsOf } from '../previews/read.js';
import { waitingSuggestionsFor } from '../suggestions/waiting-read.js';
import {
  type Built,
  base,
  decidedRows,
  type Ids,
  inboxRowsOf,
  mockupRows,
  previewRows,
  suggestionRows,
} from './approvals-rows.js';
import { type NeedsYouViewer, owedOf, readAttention } from './needs-you.js';
import { decisionsOf } from './needs-you-decisions.js';
import { releaseApprovalsOfRuns } from './ports.js';

/** A moved base's pin-only dependents, cleared by one act on the base's page (`needs-you-design.ts:repinRowOf`). */
const REPIN = 'designs.act.repinBatch';

export async function readApprovals(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<ApprovalInbox> {
  const attention = await readAttention(projectId, viewer, now);
  const mayApprovePreviews = holds(access, 'previews.approve');
  const [{ owed }, suggestions, mockups, previews] = await Promise.all([
    decisionsOf(projectId, attention),
    waitingSuggestionsFor(projectId, (p) => holds(access, p)),
    waitingMockupsAs(projectId, { userId: viewer.userId, agency: viewer.agency }),
    mayApprovePreviews ? approvablePreviewsOf(projectId) : [],
  ]);
  const approvals = owed.filter((o) => o.decision.group === 'approve');
  const runOf = new Map(
    attention.releases.releases.flatMap((r) => (r.runId ? [[r.version, r.runId] as const] : [])),
  );
  const asks = await releaseApprovalsOfRuns(
    approvals.flatMap((o) =>
      o.decision.entity === 'release' && runOf.has(o.decision.key)
        ? [runOf.get(o.decision.key) as string]
        : [],
    ),
  );
  const versionOf = new Map([...runOf].map(([v, run]) => [run, v]));
  const releaseAsks = new Map(
    asks
      .filter((a) => a.decision === null)
      .flatMap((a) => {
        const v = versionOf.get(a.runId);
        return v
          ? [[v, { userId: a.requestedByUser, at: a.requestedAt.toISOString() }] as const]
          : [];
      }),
  );
  const ids: Ids = {
    requirement: new Map(attention.requirements.map((r) => [r.key, r.id])),
    requirementTitle: new Map(attention.requirements.map((r) => [r.key, r.shortName ?? r.title])),
    design: new Map(
      [...attention.health.values()].flatMap((h) =>
        h.proposal
          ? [
              [
                h.flow,
                {
                  workflowId: h.workflowId,
                  revision: h.proposal.revision,
                  title: h.proposal.title,
                },
              ] as const,
            ]
          : [],
      ),
    ),
  };

  const built: Built[] = [
    ...(await decidedRows(approvals, ids, releaseAsks)),
    ...owedOf(attention.rows)
      .designs.filter(
        (r) => r.standing.waitingOn.says.act.key === REPIN && r.standing.waitingOn.kind === 'you',
      )
      .map(
        (r): Built => ({
          ok: true,
          row: {
            ...base,
            kind: 'repin',
            id: `repin:${r.key}`,
            key: r.key,
            title: '',
            asker: null,
            since: r.touchedAt,
            opens: { kind: 'workflow', key: r.key },
            approve: null,
            decline: null,
          },
        }),
      ),
    ...suggestionRows(projectId, suggestions),
    ...mockupRows(projectId, mockups),
  ];
  const people = await peopleOf([
    ...built.map((b) => (b.ok ? (b.row.asker?.userId ?? null) : null)),
    ...previews.map((p) => p.createdBy),
  ]);
  built.push(...previewRows(previews, people));
  const { items, unreadable } = inboxRowsOf(projectId, built, people);
  items.sort(byWaitedLongest);
  return approvalInboxSchema.parse({
    generatedAt: now.toISOString(),
    items: items.slice(0, APPROVAL_INBOX_MAX),
    unreadable: unreadable.slice(0, APPROVAL_INBOX_MAX),
    total: items.length + unreadable.length,
  });
}
