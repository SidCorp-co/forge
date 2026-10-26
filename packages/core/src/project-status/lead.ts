/**
 * The two sections a status report leads with (REQ-48, docs/proposals/steward-agent.md "Chat
 * report"): every item the standing read reads stuck, with why and the steward's line, and the
 * decisions the viewer owes, the first `NEEDS_YOU_PERSON_CAP` shown and the rest counted.
 */

import {
  byDecisionOrder,
  capDecisions,
  type NeedsYouDecision,
} from '@forge/contracts/needs-you-decisions';
import {
  PROJECT_STATUS_ROWS,
  type StatusNeedsYou,
  type StatusStuck,
  type StatusStuckItem,
  statusItemHref,
} from '@forge/contracts/project-status';
import { type ItemStanding, NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';

/**
 * Every item the standing read reads stuck, each with why and the steward's line 1: every stuck
 * requirement, oldest first, then the other items oldest first up to `PROJECT_STATUS_ROWS` rows, and
 * `count` all of them. A requirement is what a BA reads the Dashboard for, so the cap never hides one
 * (ISS-618 c2: 17 of 34 stuck requirements read on no At risk row).
 */
export function stuckOf(
  standings: readonly ItemStanding[],
  slug: string,
  asOf: string,
): StatusStuck {
  const stuck = standings.flatMap((s): StatusStuckItem[] =>
    s.stuck
      ? [
          {
            kind: s.subject.kind,
            key: s.subject.key,
            title: s.title,
            code: s.stuck.code,
            reason: s.stuck.reason,
            via: s.stuck.via,
            since: s.stuck.since,
            note: s.note && !s.note.stale ? (s.note.lines[0] ?? null) : null,
            href: statusItemHref(slug, s.subject.kind, s.subject.key),
            says: s.stuck.says,
          },
        ]
      : [],
  );
  stuck.sort((a, b) => a.since.localeCompare(b.since));
  const requirements = stuck.filter((s) => s.kind === 'requirement');
  const rest = stuck.filter((s) => s.kind !== 'requirement');
  const room = Math.max(PROJECT_STATUS_ROWS - requirements.length, 0);
  return { asOf, items: [...requirements, ...rest.slice(0, room)], count: stuck.length };
}

/** The viewer's decisions, stuck and soonest due first, capped at `NEEDS_YOU_PERSON_CAP` (BC-11). */
export function needsYouOf(
  decisions: readonly NeedsYouDecision[],
  slug: string,
  asOf: string,
): StatusNeedsYou {
  const ordered = [...decisions].sort(byDecisionOrder);
  const { shown, more } = capDecisions(ordered, NEEDS_YOU_PERSON_CAP);
  return {
    asOf,
    decisions: shown.map((d) => ({
      group: d.group,
      key: d.opens?.key ?? d.key,
      title: d.title,
      question: d.question,
      recommended: d.answers.find((a) => a.recommended)?.label ?? null,
      stuck: d.stuck,
      dueAt: d.dueAt,
      href:
        d.opens && d.opens.kind !== 'workflow' && d.opens.kind !== 'release'
          ? statusItemHref(slug, d.opens.kind, d.opens.key)
          : null,
    })),
    more,
    total: ordered.length,
  };
}
