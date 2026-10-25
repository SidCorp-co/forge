/**
 * The retired agent reports carried into Forge feedback (REQ-47 BC-8): every report still untriaged
 * becomes a report of the home project's item for its signal key, one item per key, authored by the
 * account whose session filed it. A report with no author it can name is refused and listed, never
 * filed under a substitute account. Run twice, it writes nothing the second time: each report is
 * carried once (`agent_report:<id>`), and each key's item once (`agent_report_signal:<key>`).
 */

import { type FeedbackKind, feedbackKey } from '@forge/contracts/feedback';
import type { CarryAgentReportsResult } from '@forge/contracts/forge-feedback';
import { and, eq, inArray } from 'drizzle-orm';
import { type CarriableReport, carriableReports } from '../agent-reports/index.js';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackOccurrences } from '../db/schema-feedback.js';
import { forgeHomeProject } from '../instance-settings/index.js';
import type { Refusal } from '../lib/refusal.js';
import { embedFeedbackLater } from './embeddings.js';
import { HOME_NOT_SET } from './forge-intake.js';
import { addOccurrenceIn } from './occurrences.js';
import type { FeedbackActor } from './read.js';
import { insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

const KIND_OF: Record<CarriableReport['kind'], FeedbackKind> = {
  bug: 'bug',
  suggestion: 'idea',
  learning: 'idea',
  friction: 'change_request',
  skill_gap: 'change_request',
  unclear_step: 'change_request',
  redundant_step: 'change_request',
};

const TITLE_MAX = 300;

const reportKey = (id: string) => `agent_report:${id}`;
const signalItemKey = (signalKey: string) => `agent_report_signal:${signalKey}`;

/** Why a report has no author to carry it as, or null where it has one. */
function noAuthor(r: CarriableReport): string | null {
  if (!r.sessionId) return 'it names no session, so no account filed it';
  if (!r.authorId) return `its session ${r.sessionId} names no user that still exists`;
  return null;
}

function actorOf(r: CarriableReport): FeedbackActor {
  return { userId: r.authorId as string, agency: r.authorKind === 'agent' ? 'agent' : 'human' };
}

async function fileGroupIn(
  tx: Tx,
  homeId: string,
  signalKey: string,
  reports: readonly CarriableReport[],
): Promise<{ id: string; created: boolean } | Refusal[]> {
  const [had] = await tx
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.projectId, homeId), eq(feedback.dedupKey, signalItemKey(signalKey))));
  let id = had?.id ?? '';
  for (const r of reports) {
    const source = {
      projectId: r.projectId,
      issueId: r.issueId,
      runId: r.runId,
      clientVersion: null,
    };
    if (!id) {
      const prepared = await preparedFeedback(
        homeId,
        actorOf(r),
        {
          kind: KIND_OF[r.kind],
          severity: r.severity,
          title: r.summary.trim().slice(0, TITLE_MAX),
          body: [r.detail, r.suggestion ? `Suggested: ${r.suggestion}` : null]
            .filter(Boolean)
            .join('\n\n'),
          screen: [r.target, r.targetRef].filter(Boolean).join(' '),
        },
        { writtenLang: r.writtenLang },
      );
      if (!prepared.ok) return prepared.refusals;
      id = await insertFeedbackIn(tx, {
        ...prepared.values,
        signalKey,
        dedupKey: signalItemKey(signalKey),
        createdAt: r.createdAt,
      });
    }
    await addOccurrenceIn(tx, id, actorOf(r), source, {
      dedupKey: reportKey(r.id),
      at: r.createdAt,
    });
  }
  return { id, created: !had };
}

export async function carryAgentReports(input: {
  dryRun: boolean;
}): Promise<{ ok: true; result: CarryAgentReportsResult } | { ok: false; refusals: Refusal[] }> {
  const home = await forgeHomeProject();
  if (!home) return { ok: false, refusals: [HOME_NOT_SET] };
  const all = await carriableReports();
  const untriaged = all.filter((r) => r.triage === 'new');
  const carried = new Set(
    untriaged.length === 0
      ? []
      : (
          await db
            .select({ key: feedbackOccurrences.dedupKey })
            .from(feedbackOccurrences)
            .where(
              inArray(
                feedbackOccurrences.dedupKey,
                untriaged.map((r) => reportKey(r.id)),
              ),
            )
        ).map((r) => r.key),
  );
  const result: CarryAgentReportsResult = {
    dryRun: input.dryRun,
    items: [],
    alreadyCarried: 0,
    leftTriaged: all.length - untriaged.length,
    refused: [],
  };
  const groups = new Map<string, CarriableReport[]>();
  for (const r of untriaged) {
    if (carried.has(reportKey(r.id))) {
      result.alreadyCarried += 1;
      continue;
    }
    const why = noAuthor(r);
    if (why) {
      result.refused.push({ report: r.id, signalKey: r.signalKey, why });
      continue;
    }
    groups.set(r.signalKey, [...(groups.get(r.signalKey) ?? []), r]);
  }
  for (const [signalKey, reports] of groups) {
    if (input.dryRun) {
      result.items.push({ signalKey, key: null, created: false, reports: reports.length });
      continue;
    }
    let filed: { id: string; created: boolean } | null = null;
    const refusals = await inTx(async (tx) => {
      await lockFeedback(tx, home.id);
      const out = await fileGroupIn(tx, home.id, signalKey, reports);
      if (Array.isArray(out)) return out;
      filed = out;
      return null;
    });
    if (refusals || !filed) {
      for (const r of reports) {
        result.refused.push({
          report: r.id,
          signalKey,
          why: (refusals ?? []).map((f) => `${f.code}: ${f.detail}`).join('; '),
        });
      }
      continue;
    }
    const { id, created } = filed as { id: string; created: boolean };
    const [row] = await db
      .select({ seq: feedback.fbSeq })
      .from(feedback)
      .where(eq(feedback.id, id));
    if (created) embedFeedbackLater(id);
    result.items.push({
      signalKey,
      key: row ? feedbackKey(row.seq) : null,
      created,
      reports: reports.length,
    });
  }
  return { ok: true, result };
}
