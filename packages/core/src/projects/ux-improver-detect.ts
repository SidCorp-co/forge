// UX Improver, detection half — ISS-579. Pure: findings + the current rule set
// in, proposals and refusals out. No DB, no clock of its own.
//
// This is the deterministic tier of the UX Completeness Contract's learning
// loop. It clusters findings, applies the recurrence bar, and refuses what the
// evidence does not support. Judging whether a recurring gap deserves to become
// a permanent rule is the standing `ux-contract-improve` agent's job, and
// approving it is the human's.

import { createHash } from 'node:crypto';
import type {
  UxImproverCandidate,
  UxImproverCandidateKind,
  UxImproverRefusal,
  UxImproverReport,
  UxRuleGroup,
  UxRuleSeverity,
} from '@forge/contracts';
import { sanitizeUntrusted, stripFrameTokens } from '../prompt/sanitize.js';

/** How far back findings are considered fuel. Older gaps describe a UI that has moved on. */
export const LOOKBACK_DAYS = 90;

// cm:guard Never lower this to 1 — the whole point of the improver is that one agent's one observation must not become a permanent rule injected into every future prompt. ISS-579's acceptance criterion tests exactly this half: a single non-recurring finding produces nothing.
export const MIN_RECURRENCE_ISSUES = 3;

/** Jaccard floor over normalized detail tokens for two findings to describe the same gap. */
export const SIMILARITY_THRESHOLD = 0.5;

/** A `proposed` learned rule nobody actioned goes stale after this, and the improver withdraws it. */
export const STALE_PROPOSAL_DAYS = 60;

const DAY_MS = 86_400_000;

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'has',
  'have',
  'not',
  'but',
  'are',
  'was',
  'were',
  'its',
  'from',
  'into',
  'when',
  'then',
  'than',
  'there',
  'here',
  'all',
  'any',
  'our',
  'your',
  'their',
  'you',
  'use',
  'used',
  'uses',
  'per',
  'via',
  'own',
  'onto',
  'over',
  'under',
  'only',
  'also',
  'does',
  'did',
  'doing',
  'been',
  'being',
  'which',
  'while',
  'where',
  'what',
  'who',
  'how',
  'why',
]);

const GROUP_FOR_KIND: Record<string, UxRuleGroup> = {
  'missing-state': 'states',
  a11y: 'a11y',
  microcopy: 'microcopy',
  responsive: 'responsive',
  'design-system': 'designSystem',
  other: 'flows',
};

export interface UxImproverFindingInput {
  id: string;
  issueId: string;
  runId: string | null;
  stage: string;
  ruleId: string | null;
  kind: string;
  detail: string;
  severity: UxRuleSeverity;
  createdAt: Date;
}

export interface UxImproverRuleInput {
  id: string;
  supersedesRuleId: string | null;
  group: UxRuleGroup;
  text: string;
  severity: UxRuleSeverity;
  source: string;
  status: string;
  evidenceIssueIds: string[];
  orderIndex: number;
  updatedAt: Date;
}

export interface DetectUxImproverInput {
  findings: UxImproverFindingInput[];
  rules: UxImproverRuleInput[];
  now: Date;
}

export function normalizeTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface Cluster {
  ruleId: string | null;
  kind: string;
  members: UxImproverFindingInput[];
  tokens: Set<string>[];
}

// cm:guard Sort by (createdAt, id) before the greedy pass and compare only against each cluster's SEED, never its members — both are what make the clustering deterministic and chain-free. Single-linkage over members would let A~B~C merge while A and C describe different gaps, and the same finding set would cluster differently depending on insertion order.
function clusterFindings(findings: UxImproverFindingInput[]): Cluster[] {
  const ordered = [...findings].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );

  const byRule = new Map<string, Cluster>();
  const uncited: Cluster[] = [];

  for (const finding of ordered) {
    const tokens = normalizeTokens(finding.detail);

    if (finding.ruleId) {
      const existing = byRule.get(finding.ruleId);
      if (existing) {
        existing.members.push(finding);
        existing.tokens.push(tokens);
      } else {
        byRule.set(finding.ruleId, {
          ruleId: finding.ruleId,
          kind: finding.kind,
          members: [finding],
          tokens: [tokens],
        });
      }
      continue;
    }

    const seedMatch = uncited.find(
      (c) =>
        c.kind === finding.kind &&
        jaccard(c.tokens[0] as Set<string>, tokens) >= SIMILARITY_THRESHOLD,
    );
    if (seedMatch) {
      seedMatch.members.push(finding);
      seedMatch.tokens.push(tokens);
    } else {
      uncited.push({ ruleId: null, kind: finding.kind, members: [finding], tokens: [tokens] });
    }
  }

  return [...byRule.values(), ...uncited];
}

/** The member whose wording sits closest to the rest — the cluster's clearest statement of the gap. */
function medoid(cluster: Cluster): UxImproverFindingInput {
  let best = cluster.members[0] as UxImproverFindingInput;
  let bestScore = -1;
  for (let i = 0; i < cluster.members.length; i += 1) {
    let score = 0;
    for (let j = 0; j < cluster.members.length; j += 1) {
      if (i === j) continue;
      score += jaccard(cluster.tokens[i] as Set<string>, cluster.tokens[j] as Set<string>);
    }
    if (score > bestScore) {
      bestScore = score;
      best = cluster.members[i] as UxImproverFindingInput;
    }
  }
  return best;
}

// cm:guard An APPROVED rule is injected verbatim into every agent prompt on the project, and this text came from an agent-authored ux_findings.detail — so it must go through the same chokepoint as any other untrusted prompt input. The human approving it in the inbox is the second control, not the first.
function proposedRuleText(detail: string): string {
  return stripFrameTokens(sanitizeUntrusted(detail)).trim();
}

// cm:guard `already-proposed` is the ONLY refusal `applyUxImproverProposals` acts on — it unions `evidenceIssueIds` onto `targetRuleId`. Emit it without those two fields populated and a proposal's evidence silently freezes at whatever the first run saw, while the inbox keeps showing three issues for a gap that has now hit ten.
function alreadyProposed(ruleId: string, sample: string, issues: string[]): UxImproverRefusal {
  return {
    kind: 'add',
    reason: 'already-proposed',
    detail: `Rule ${ruleId} is already waiting in the inbox for this gap; its evidence is refreshed instead.`,
    sample,
    distinctIssueCount: issues.length,
    targetRuleId: ruleId,
    evidenceIssueIds: issues,
  };
}

/** A `proposed` row already queued to replace `targetId` — a second one would double the inbox. */
function pendingSupersede(
  rules: UxImproverRuleInput[],
  targetId: string,
): UxImproverRuleInput | undefined {
  return rules.find((r) => r.status === 'proposed' && r.supersedesRuleId === targetId);
}

function distinctIssueIds(cluster: Cluster): string[] {
  const seen: string[] = [];
  for (const m of cluster.members) if (!seen.includes(m.issueId)) seen.push(m.issueId);
  return seen;
}

function candidateKey(kind: UxImproverCandidateKind, group: string, signature: string): string {
  const digest = createHash('sha1').update(signature).digest('hex').slice(0, 12);
  return `${kind}:${group}:${digest}`;
}

interface CoverMatch {
  rule: UxImproverRuleInput;
  similarity: number;
}

function bestCover(
  tokens: Set<string>,
  group: UxRuleGroup,
  rules: UxImproverRuleInput[],
  status: string,
): CoverMatch | null {
  let best: CoverMatch | null = null;
  for (const rule of rules) {
    if (rule.status !== status || rule.group !== group) continue;
    const similarity = jaccard(tokens, normalizeTokens(rule.text));
    if (similarity >= SIMILARITY_THRESHOLD && (best === null || similarity > best.similarity)) {
      best = { rule, similarity };
    }
  }
  return best;
}

/**
 * Pure: findings + current rules → the proposals a human should see, and the
 * ones the improver refused to make. Both halves are returned — a refusal the
 * caller cannot read is indistinguishable from a gap the improver never noticed.
 */
export function detectUxImproverCandidates(input: DetectUxImproverInput): UxImproverReport {
  const { rules, now } = input;
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const findings = input.findings.filter((f) => f.createdAt >= cutoff);
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const candidates: UxImproverCandidate[] = [];
  const refused: UxImproverRefusal[] = [];
  const clusters = clusterFindings(findings);
  const recurringSignatures: Set<string>[] = [];

  for (const cluster of clusters) {
    const issues = distinctIssueIds(cluster);
    const rep = medoid(cluster);
    const repTokens = normalizeTokens(rep.detail);
    const citedRule = cluster.ruleId ? ruleById.get(cluster.ruleId) : undefined;
    const group = citedRule?.group ?? GROUP_FOR_KIND[cluster.kind] ?? ('flows' as UxRuleGroup);
    const signature = citedRule ? `rule:${citedRule.id}` : `gap:${group}:${rep.detail}`;
    const shared = {
      group,
      evidenceIssueIds: issues,
      findingIds: cluster.members.map((m) => m.id),
      distinctIssueCount: issues.length,
      occurrences: cluster.members.length,
    };

    if (issues.length < MIN_RECURRENCE_ISSUES) {
      refused.push({
        kind: citedRule && citedRule.severity === 'should' ? 'strengthen' : 'add',
        reason: 'one-off',
        detail: `Seen on ${issues.length} issue(s); needs ${MIN_RECURRENCE_ISSUES} to count as recurring.`,
        sample: rep.detail,
        distinctIssueCount: issues.length,
        targetRuleId: null,
        evidenceIssueIds: issues,
      });
      continue;
    }

    recurringSignatures.push(repTokens);

    if (citedRule && citedRule.status === 'active') {
      if (citedRule.severity === 'must') {
        refused.push({
          kind: 'strengthen',
          reason: 'already-covered',
          detail: `Rule ${citedRule.id} already binds at "must" — repeat violations are a compliance problem, not a contract gap.`,
          sample: rep.detail,
          distinctIssueCount: issues.length,
          targetRuleId: citedRule.id,
          evidenceIssueIds: issues,
        });
        continue;
      }
      const pending = pendingSupersede(rules, citedRule.id);
      if (pending) {
        refused.push(alreadyProposed(pending.id, rep.detail, issues));
        continue;
      }
      candidates.push({
        ...shared,
        key: candidateKey('strengthen', group, signature),
        kind: 'strengthen',
        text: citedRule.text,
        severity: 'must',
        targetRuleId: citedRule.id,
        rationale: `Cited on ${issues.length} issues while binding only as "should".`,
      });
      continue;
    }

    const coveredByActive = bestCover(repTokens, group, rules, 'active');
    if (coveredByActive) {
      if (coveredByActive.rule.severity === 'should') {
        const pending = pendingSupersede(rules, coveredByActive.rule.id);
        if (pending) {
          refused.push(alreadyProposed(pending.id, rep.detail, issues));
          continue;
        }
        candidates.push({
          ...shared,
          key: candidateKey('strengthen', group, `rule:${coveredByActive.rule.id}`),
          kind: 'strengthen',
          text: coveredByActive.rule.text,
          severity: 'must',
          targetRuleId: coveredByActive.rule.id,
          rationale: `An existing "should" rule already describes this gap, and it recurred on ${issues.length} issues.`,
        });
      } else {
        refused.push({
          kind: 'add',
          reason: 'already-covered',
          detail: `An active "must" rule already covers this (${coveredByActive.rule.id}).`,
          sample: rep.detail,
          distinctIssueCount: issues.length,
          targetRuleId: coveredByActive.rule.id,
          evidenceIssueIds: issues,
        });
      }
      continue;
    }

    const coveredByProposed = bestCover(repTokens, group, rules, 'proposed');
    if (coveredByProposed) {
      refused.push(alreadyProposed(coveredByProposed.rule.id, rep.detail, issues));
      continue;
    }

    candidates.push({
      ...shared,
      key: candidateKey('add', group, signature),
      kind: 'add',
      text: proposedRuleText(rep.detail),
      severity: cluster.members.some((m) => m.severity === 'must') ? 'must' : 'should',
      targetRuleId: null,
      rationale: `Same gap observed ${cluster.members.length} times across ${issues.length} issues, and no active rule covers it.`,
    });
  }

  const staleBefore = new Date(now.getTime() - STALE_PROPOSAL_DAYS * DAY_MS);
  for (const rule of rules) {
    if (rule.status !== 'proposed' || rule.source !== 'learned') continue;
    // cm:guard The admin create route lets a human set `source: 'learned'` by hand, so source alone does not prove the improver authored this. Non-empty evidence does: `ruleCreateSchema` has no evidenceIssueIds field, so only the improver can produce one. Drop this and the improver silently withdraws a human's proposal.
    if (rule.evidenceIssueIds.length === 0) continue;
    if (rule.updatedAt >= staleBefore) continue;
    const ruleTokens = normalizeTokens(rule.text);
    if (recurringSignatures.some((s) => jaccard(s, ruleTokens) >= SIMILARITY_THRESHOLD)) continue;
    candidates.push({
      key: candidateKey('retire', rule.group, `rule:${rule.id}`),
      kind: 'retire',
      group: rule.group,
      text: rule.text,
      severity: rule.severity,
      targetRuleId: rule.id,
      evidenceIssueIds: rule.evidenceIssueIds,
      findingIds: [],
      distinctIssueCount: 0,
      occurrences: 0,
      rationale: `Proposed over ${STALE_PROPOSAL_DAYS} days ago, still unapproved, and the gap has stopped recurring.`,
    });
  }

  return {
    findingsConsidered: findings.length,
    clusters: clusters.length,
    candidates,
    refused,
    thresholds: {
      lookbackDays: LOOKBACK_DAYS,
      minRecurrenceIssues: MIN_RECURRENCE_ISSUES,
      similarityThreshold: SIMILARITY_THRESHOLD,
      staleProposalDays: STALE_PROPOSAL_DAYS,
    },
  };
}
