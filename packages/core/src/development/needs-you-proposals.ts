/**
 * What an agent's suggestion proposes, as the one Needs you page reads it (REQ-48 BC-11,
 * `@forge/contracts/needs-you-proposal`): the act as a verb and its object, whether the agent
 * recommends it, its tags, what approving changes and why, read from the suggestion's own payload
 * and the record it is on, never from prose. A payload its kind's schema refuses throws, so the fold
 * names the record unreadable rather than guessing what it proposed.
 */

import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_SEVERITY_LABELS,
  type FeedbackKind,
  type FeedbackSeverity,
} from '@forge/contracts/feedback';
import { namedCriterionOf } from '@forge/contracts/feedback-triage';
import type { DecisionProposal, NeedsYouYield } from '@forge/contracts/needs-you-proposal';
import { SUGGESTION_PAYLOADS, type SuggestionKind } from '@forge/contracts/suggestions';
import type { z } from 'zod';

type Payload<K extends SuggestionKind> = z.infer<(typeof SUGGESTION_PAYLOADS)[K]['schema']>;
type Tag = DecisionProposal['tags'][number];

/** The record a feedback triage is on, as the page needs it beside the payload. */
export interface TriagedItem {
  key: string;
  kind: FeedbackKind;
  severity: FeedbackSeverity;
  body: string | null;
  whereSeen: string | null;
}

/** A requirement a breakdown is proposed for: its criteria and the issues that already carry it. */
export interface BrokenDown {
  key: string;
  criteria: number;
  carriedBy: readonly string[];
}

/** A dedup nearest this close reads as a tag; this close, as a warning. */
const NEAR = 0.8;
const NEARER = 0.88;

const quoted = (s: string | undefined | null) => (s ? `“${s}”` : '');
const yields = (kind: NeedsYouYield, n = 1) => [{ kind, n }];
const percent = (x: number) => `${Math.round(x * 100)}%`;
const keysOf = (ref: string | readonly string[] | undefined) =>
  ref === undefined ? [] : typeof ref === 'string' ? [ref] : [...ref];

export function parsePayload<K extends SuggestionKind>(kind: K, payload: unknown): Payload<K> {
  return SUGGESTION_PAYLOADS[kind].schema.parse(payload) as Payload<K>;
}

const empty = {
  tags: [] as Tag[],
  consequences: [] as string[],
  why: [] as DecisionProposal['why'],
  said: null,
  table: null,
  yields: [] as DecisionProposal['yields'],
};

/** What a triage's route proposes: the act, its object, what approving changes and what it yields. */
function triageAct(p: Payload<'feedback_triage'>, key: string) {
  const carriers = keysOf(p.issue);
  switch (p.route ?? 'issue') {
    case 'issue': {
      if (carriers.length > 0) {
        return {
          verb: `Carry on ${carriers.join(', ')}`,
          what: p.note ?? '',
          consequences: [
            `${key} moves to Planned, carried by ${carriers.join(', ')}`,
            'The reporter is told when it ships',
          ],
          yields: [],
        };
      }
      const c = p.createIssue;
      const bands = [
        c?.category,
        c?.priority,
        c?.complexity ? `size ${c.complexity}` : undefined,
      ].filter(Boolean);
      return {
        verb: 'New issue',
        what: quoted(c?.title),
        consequences: [
          `Issue ${quoted(c?.title) || 'from this item'} is created${bands.length ? ` (${bands.join(', ')})` : ''}`,
          `${key} moves to Planned, carried by that issue`,
          'The reporter is told when it ships',
        ],
        yields: yields('new_issue'),
      };
    }
    case 'revision':
      return {
        verb: `Revise ${p.requirement ?? 'the requirement'}`,
        what: quoted(p.title),
        consequences: [
          `A revision of ${p.requirement ?? 'the requirement'} is drafted`,
          `${key} moves to Planned, carried by that revision`,
        ],
        yields: yields('revision'),
      };
    case 'new_requirement':
      return {
        verb: 'New requirement',
        what: quoted(p.title),
        consequences: [
          `A requirement ${quoted(p.title)} is drafted`,
          `${key} moves to Planned, carried by it`,
        ],
        yields: yields('revision'),
      };
    case 'answer':
      return {
        verb: 'Answer',
        what: p.answer ?? '',
        consequences: [`${key} is answered with the agent's words, and its reporter told`],
        yields: yields('closed'),
      };
    case 'duplicate':
      return {
        verb: `Duplicate of ${p.duplicateOf ?? 'an earlier item'}`,
        what: p.note ?? '',
        consequences: [
          `${key} closes as a duplicate of ${p.duplicateOf}`,
          `Its reporter follows ${p.duplicateOf} instead`,
        ],
        yields: yields('closed'),
      };
    case 'decline':
      return {
        verb: 'Decline',
        what: p.note ?? '',
        consequences: [
          `${key} is declined with the agent's note as the reason`,
          'Nothing else changes',
        ],
        yields: yields('closed'),
      };
  }
}

/**
 * A feedback triage: an issue, revision or requirement route is recommended only where a recording
 * reproduced it (its diagnosis); a close (duplicate, decline, answer) is recommended as it stands.
 * The free-text reproduction answer is shown under Why and never parsed.
 */
export function triageProposal(payload: unknown, item: TriagedItem): DecisionProposal {
  const p = parsePayload('feedback_triage', payload);
  const act = triageAct(p, item.key);
  const route = p.route ?? 'issue';
  const builds = route === 'issue' || route === 'revision' || route === 'new_requirement';
  const reproduced = p.diagnosis !== undefined;
  const answers = (p.answers ?? {}) as Record<string, unknown>;
  const criterion = namedCriterionOf(p.answers);
  const severity = (
    typeof answers.severity === 'string' ? answers.severity : item.severity
  ) as FeedbackSeverity;
  const kind = FEEDBACK_KIND_LABELS[p.kind ?? item.kind];
  const sev = FEEDBACK_SEVERITY_LABELS[severity] ?? severity;
  const nearest =
    p.dedup?.nearest && p.dedup.similarity !== undefined
      ? { key: p.dedup.nearest, sim: p.dedup.similarity }
      : null;
  const tags: Tag[] = [{ text: `${kind} · ${sev.toLowerCase()}`, tone: 'plain' }];
  if (builds)
    tags.push(
      reproduced ? { text: 'Reproduced', tone: 'ok' } : { text: 'Not reproduced', tone: 'warn' },
    );
  if (nearest && nearest.sim >= NEAR)
    tags.push({
      text: `≈ ${nearest.key} ${percent(nearest.sim)}`,
      tone: nearest.sim >= NEARER ? 'warn' : 'plain',
    });
  if (criterion) tags.push({ text: `${criterion.requirement} ${criterion.code}`, tone: 'plain' });
  const why: DecisionProposal['why'] = [];
  if (p.diagnosis)
    why.push(
      { label: 'Cause', value: p.diagnosis.cause },
      { label: 'Fix', value: p.diagnosis.fix },
    );
  if (typeof answers.reproduced === 'string' && answers.reproduced.trim())
    why.push({ label: 'Reproduced', value: answers.reproduced });
  if (nearest)
    why.push({
      label: 'Closest item',
      value: `${nearest.key} · ${percent(nearest.sim)} similar${route === 'duplicate' ? '' : ', judged different'}`,
    });
  if (criterion)
    why.push({ label: 'Criterion', value: `${criterion.requirement} ${criterion.code}` });
  why.push({ label: 'Kind', value: `${kind} · ${sev.toLowerCase()}` });
  if (item.whereSeen) why.push({ label: 'Seen at', value: item.whereSeen });
  return {
    ...empty,
    verb: act.verb,
    what: act.what,
    recommends: builds ? reproduced : true,
    tags,
    consequences: act.consequences,
    why,
    said: item.body,
    yields: act.yields,
  };
}

/** A breakdown: recommended unless the requirement is already carried by issues, which it would double. */
export function breakdownProposal(payload: unknown, req: BrokenDown): DecisionProposal {
  const p = parsePayload('breakdown', payload);
  const traced = new Set(p.issues.flatMap((i) => i.criteria.map((c) => c.tracesTo)));
  const n = p.issues.length;
  const tags: Tag[] = [];
  if (req.carriedBy.length > 0)
    tags.push({ text: `Already carried by ${req.carriedBy.join(', ')}`, tone: 'warn' });
  tags.push({ text: `BC ${traced.size} of ${req.criteria} traced`, tone: 'plain' });
  return {
    ...empty,
    verb: `Break into ${n} ${n === 1 ? 'issue' : 'issues'}`,
    what: `${n} draft ${n === 1 ? 'issue' : 'issues'} covering ${traced.size} ${traced.size === 1 ? 'criterion' : 'criteria'}`,
    recommends: req.carriedBy.length === 0,
    tags,
    consequences: [
      `${n} draft ${n === 1 ? 'issue is' : 'issues are'} created, each tracing its criteria`,
      ...(req.carriedBy.length > 0
        ? [
            `${req.key} is already carried by ${req.carriedBy.join(' and ')}; these trace the same criteria again`,
          ]
        : []),
      'The master picks them up in its next pass',
    ],
    table: {
      title: 'Proposed issues',
      columns: ['Issue', 'Criteria'],
      rows: p.issues.map((i) => [
        [i.title, [i.category, i.builds ? `builds ${i.builds}` : null].filter(Boolean).join(' · ')]
          .filter(Boolean)
          .join('\n'),
        [...new Set(i.criteria.map((c) => c.tracesTo))].join(' '),
      ]),
    },
    yields: yields('draft_issue', n),
  };
}

/** Every other suggestion kind: its act in a verb, what approving applies, and no recommendation of its own. */
export function suggestionProposal(
  kind: SuggestionKind,
  payload: unknown,
  target: string,
): DecisionProposal {
  const base = { ...empty, recommends: false };
  switch (kind) {
    case 'revision_diff': {
      const p = parsePayload('revision_diff', payload);
      return {
        ...base,
        verb: `Revise ${target}`,
        what: p.changeSummary ?? p.tldr ?? p.reason,
        consequences: [`A revision of ${target} is drafted from it`],
        why: [{ label: 'Reason', value: p.reason }],
        yields: yields('revision'),
      };
    }
    case 'requirement_draft': {
      const p = parsePayload('requirement_draft', payload);
      return {
        ...base,
        verb: 'New requirement',
        what: quoted(p.title),
        consequences: [`A requirement ${quoted(p.title)} is drafted`],
        why: [{ label: 'Reason', value: p.reason }],
        yields: yields('revision'),
      };
    }
    case 'duplicate': {
      const p = parsePayload('duplicate', payload);
      return {
        ...base,
        verb: `Duplicate of ${p.duplicateOf}`,
        what: p.note ?? '',
        consequences: [`${target} closes as a duplicate of ${p.duplicateOf}`],
        yields: yields('closed'),
      };
    }
    case 'design_change': {
      const p = parsePayload('design_change', payload);
      const parts = [...(p.steps ?? []), ...(p.edges ?? []).map((e) => `${e.from} → ${e.to}`)];
      return {
        ...base,
        verb: `Change ${target}`,
        what: p.reason,
        consequences: [`A revision of ${target} is proposed touching ${parts.join(', ')}`],
        yields: yields('approved'),
      };
    }
    case 'readiness': {
      const p = parsePayload('readiness', payload);
      const passed = p.checks.filter((c) => c.passed).length;
      return {
        ...base,
        verb: 'Readiness check',
        what: `${passed} of ${p.checks.length} checks pass`,
        consequences: [`The checks are recorded on ${target}`],
        why: p.checks.map((c) => ({ label: c.passed ? 'Passes' : 'Fails', value: c.check })),
        yields: yields('approved'),
      };
    }
    case 'triage': {
      const p = parsePayload('triage', payload);
      return {
        ...base,
        verb: `Triage ${target}`,
        what: p.note,
        consequences: [`${target} takes the triage as proposed`],
        yields: yields('approved'),
      };
    }
    case 'breakdown':
    case 'feedback_triage':
      throw new Error(
        `needs-you: a ${kind} suggestion is read by its own proposal, with its record`,
      );
  }
}
