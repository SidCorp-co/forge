import { describe, expect, it } from 'vitest';
import type { agentSessions } from '../db/schema.js';
import {
  FAILURE_CAUSE_ORIGIN,
  FAILURE_CAUSES,
  type FailureCause,
  isRealFailureCause,
  LEGACY_CAUSE_ALIAS,
  resolveFailureCause,
} from './failure-causes.js';
import { classifyFailure } from './failure-classifier.js';

/**
 * The golden fixture ISS-877 mandated: the eight sessions ISS-871 burned
 * 15h27m and 17,902 messages on and closed as "Not diagnosed". These are the
 * verbatim `jobs.error` strings those runs left behind, read off the read-only
 * replica on 2026-08-29, paired with the cause read out of each transcript.
 *
 * Everything here is a plain string in, a plain string out. No database, no
 * container, no network — which is the third constraint, and the reason a
 * regression in this taxonomy is catchable by anyone with a checkout.
 */
const ISS871_SESSIONS: ReadonlyArray<{
  session: string;
  issue: string;
  messages: number;
  error: string;
  cause: FailureCause;
}> = [
  {
    session: '1a950b18-980b-4ca7-8c0b-748d235b3b77',
    issue: 'ISS-787',
    messages: 9403,
    error: '[claude-code:unrecognized_model] {"model":"cx/gpt-5.6-terra","query_source":"sdk"}',
    cause: 'provider_refused_request',
  },
  {
    session: '6e294748-af1e-4228-b3a1-5f7aed195bc9',
    issue: 'ISS-718',
    messages: 1981,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 1:40pm (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
  {
    session: '5637fc9e-ce77-4db5-8fd8-ace84c70010b',
    issue: 'ISS-789',
    messages: 1513,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 3:50am (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
  {
    session: '4ea61948-1568-4c58-8470-836ebf6995e1',
    issue: 'ISS-652',
    messages: 1414,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 1:50pm (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
  {
    session: '52df36f8-4c85-422e-bb88-ce86c326c08a',
    issue: 'ISS-833',
    messages: 1410,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 5:20am (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
  {
    session: 'd93f8d73-e63c-4693-a9d5-3a108584f766',
    issue: 'ISS-868',
    messages: 1290,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 3:10pm (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
  {
    session: '75a32260-9584-4333-be28-ea7944a005ee',
    issue: 'ISS-787',
    messages: 623,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your weekly limit resets Aug 29, 6am (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
  {
    session: '4b7edd76-567c-44cb-964f-1731a31f6a86',
    issue: 'ISS-652',
    messages: 268,
    error:
      "[RESULT_ERROR] success: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your weekly limit resets Aug 29, 6am (Asia/Ho_Chi_Minh)",
    cause: 'provider_spend_cap',
  },
];

describe('ISS-871 golden fixture — the eight undiagnosed sessions', () => {
  for (const s of ISS871_SESSIONS) {
    it(`${s.session.slice(0, 8)} (${s.issue}, ${s.messages} msgs) → ${s.cause}`, () => {
      expect(classifyFailure({ error: s.error }).cause).toBe(s.cause);
    });
  }

  it('separates the one session that died of something else from the seven that did not', () => {
    const causes = ISS871_SESSIONS.map((s) => classifyFailure({ error: s.error }).cause);
    expect(causes.filter((c) => c === 'provider_spend_cap')).toHaveLength(7);
    expect(causes.filter((c) => c === 'provider_refused_request')).toHaveLength(1);
  });

  it('leaves none of them unclassified — the state this issue exists to end', () => {
    for (const s of ISS871_SESSIONS) {
      expect(classifyFailure({ error: s.error }).cause).not.toBe('unclassified');
    }
  });

  it('records the total the issue used to identify this exact set', () => {
    expect(ISS871_SESSIONS.reduce((n, s) => n + s.messages, 0)).toBe(17902);
  });
});

/**
 * One live signature per cause, each copied from the read-only replica on
 * 2026-08-29. This is the evidence half of "no member with zero live rows":
 * a cause invented to round out the set has no row to put here.
 */
const LIVE_SIGNATURES: ReadonlyArray<[FailureCause, string]> = [
  [
    'provider_subscription_disabled',
    '[RESULT_ERROR] success: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
  ],
  [
    'provider_auth_expired',
    '[RESULT_ERROR] success: Failed to authenticate: OAuth session expired and could not be refreshed',
  ],
  ['provider_auth_expired', '[RESULT_ERROR] success: Not logged in · Please run /login'],
  [
    'provider_overloaded',
    '[RESULT_ERROR] success: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
  ],
  [
    'provider_overloaded',
    '[RESULT_ERROR] success: API Error: Connection closed mid-response. The response above may be incomplete.',
  ],
  [
    'agent_skill_missing',
    '[NO_WORK] claude produced 0 turns — no work done (skill likely not installed on this device): Unknown command: /forge-drive',
  ],
  [
    'agent_startup_failed',
    'Error: Invalid MCP configuration:\nMCP config file not found: /home/forge/.config/forge-runner/mcp/forge-mcp-pipeline.json',
  ],
  ['agent_startup_failed', '[MCP_INIT_FAILED] forge did not connect at startup'],
  [
    'agent_exited_without_result',
    '[NO_RESULT_CLEAN_EXIT] claude exited 0 before emitting a result event',
  ],
  ['agent_exited_without_result', 'Agent completed with errors'],
  ['resume_failed', 'No conversation found with session ID: 8e058709-9cdf-4914-a7e0-5ae68a3408ad'],
  ['agent_killed', '[SIGNAL_KILLED] signal=9'],
  ['workspace_preflight_failed', 'preflight_failed: work_tree /home/forge/projects/anhome'],
  [
    'workspace_disk_full',
    'failed to start chat turn: io error: No space left on device (os error 28)',
  ],
  [
    'runner_unreachable',
    'dispatch not delivered: no open websocket on the device (job.assigned reached 0 subscribers)',
  ],
  ['runner_unreachable', 'dispatch_unclaimed'],
  ['session_lost', 'session_lost'],
  ['duplex_channel_failed', 'session_ack_timeout'],
  ['runner_unsupported_type', 'runner_unsupported_type:claude-code'],
  ['forge_budget_exhausted', 'monthly_budget_exhausted'],
  ['resume_failed', 'resume_failed'],
];

describe('every cause traces to a signature that actually occurred', () => {
  for (const [cause, error] of LIVE_SIGNATURES) {
    it(`${cause} ← ${error.slice(0, 52)}…`, () => {
      expect(classifyFailure({ error }).cause).toBe(cause);
    });
  }
});

describe('the taxonomy itself', () => {
  it('gives every cause an origin', () => {
    for (const cause of FAILURE_CAUSES) {
      expect(FAILURE_CAUSE_ORIGIN[cause]).toBeTruthy();
    }
    expect(Object.keys(FAILURE_CAUSE_ORIGIN).sort()).toEqual([...FAILURE_CAUSES].sort());
  });

  it('has no duplicate members', () => {
    expect(new Set(FAILURE_CAUSES).size).toBe(FAILURE_CAUSES.length);
  });

  it('reads lifecycle conclusions and user cancels as NOT failures', () => {
    expect(isRealFailureCause('pipeline_completed')).toBe(false);
    expect(isRealFailureCause('orphan_under_terminal_run')).toBe(false);
    expect(isRealFailureCause('user_cancelled')).toBe(false);
    expect(isRealFailureCause('provider_spend_cap')).toBe(true);
    expect(isRealFailureCause('unclassified')).toBe(true);
  });
});

describe('legacy rows stay readable without being rewritten', () => {
  it('resolves job_failed to unclassified, which is what that era was', () => {
    expect(resolveFailureCause('job_failed')).toBe('unclassified');
  });

  it('resolves the pre-ISS-877 tokens that are still on live rows', () => {
    expect(resolveFailureCause('usage_limit')).toBe('provider_usage_limit');
    expect(resolveFailureCause('ws-publish-failed')).toBe('ws_publish_failed');
  });

  it('passes a current member through untouched', () => {
    for (const cause of FAILURE_CAUSES) {
      expect(resolveFailureCause(cause)).toBe(cause);
    }
  });

  it('reads the free text that leaked into the column as unclassified, not as itself', () => {
    // cm:why verbatim from `agent_sessions.failure_reason` on forge-beta 2026-08-11 — a schedule agent's own prompt, stored as the reason it failed; the point of the assertion is that this string must NEVER round-trip as itself
    const prompt =
      "You are the Forge product-map refresh agent. Your job: keep this project's curated PRODUCT map current from the issue stream";
    expect(resolveFailureCause(prompt)).toBe('unclassified');
    expect(resolveFailureCause('org/account spend limit → per-account failover')).toBe(
      'unclassified',
    );
  });

  it('reads null and empty as unclassified rather than throwing', () => {
    expect(resolveFailureCause(null)).toBe('unclassified');
    expect(resolveFailureCause(undefined)).toBe('unclassified');
    expect(resolveFailureCause('')).toBe('unclassified');
  });

  it('aliases only to real members', () => {
    for (const target of Object.values(LEGACY_CAUSE_ALIAS)) {
      expect(FAILURE_CAUSES).toContain(target);
    }
  });
});

describe('free text never reads back as itself', () => {
  it('normalizes the prose 55 live rows hold, rather than surfacing it as a cause', () => {
    expect(resolveFailureCause('[RESULT_ERROR] success: something nobody has a pattern for')).toBe(
      'unclassified',
    );
    expect(resolveFailureCause("I'll check ISS-54's status and what it's waiting on.")).toBe(
      'unclassified',
    );
  });
});

describe('the column cannot take free text', () => {
  // cm:guard this assertion IS the enforcement — remove `{ enum: agentSessionFailureReasons }` from the column and `Insert['failureReason']` widens to `string`, which no runtime test can see and no other test asserts. It compiles to `true` only while the column is bound; unbound, the conditional resolves to `never` and `typecheck` fails here naming this line.
  it('types the insert as a FailureCause, so a sentence is a build error', () => {
    type Inserted = NonNullable<typeof agentSessions.$inferInsert.failureReason>;
    type BoundToTaxonomy = Inserted extends FailureCause ? true : never;
    const bound: BoundToTaxonomy = true;
    expect(bound).toBe(true);
  });
});

describe('unclassified is counted, not hidden', () => {
  it('is a member of the enum, so any group-by returns it as a row', () => {
    expect(FAILURE_CAUSES).toContain('unclassified');
  });

  it('is reached with meta.needsReview set, so the count and the review queue agree', () => {
    const result = classifyFailure({ error: 'a shape no rule has ever seen' });
    expect(result.cause).toBe('unclassified');
    expect(result.meta?.needsReview).toBe(true);
  });

  it('is NOT reached for anything the taxonomy does name', () => {
    for (const [, error] of LIVE_SIGNATURES) {
      expect(classifyFailure({ error }).cause).not.toBe('unclassified');
    }
  });
});

describe("the classifier's own verdicts survive the round trip", () => {
  // cm:why `agent-session-link.ts#deriveSessionFailure` joins `jobs.failure_reason` (a classifier `reason` sentence) with `jobs.error` and classifies the pair, so the classifier reads its own output. 88 live rows proved what that costs: the job row said `cc-startup-death (≤3 msgs, no tool use)` and the session row said nothing, which is `job_failed` under a new name.
  it('classifies the startup-death verdict the job lane already wrote, joined with a detail-free CLI error', () => {
    const r = classifyFailure({
      error: 'cc-startup-death (≤3 msgs, no tool use) — [RESULT_ERROR] error_during_execution',
    });
    expect(r.cause).toBe('agent_startup_failed');
  });

  it('keeps the pattern-matched startup death separate from the signal-derived one', () => {
    expect(classifyFailure({ error: 'cc-startup-death (pattern match)' }).cause).toBe(
      'agent_skill_missing',
    );
  });

  it('lets a named provider cause in the same text outrank the startup verdict', () => {
    const r = classifyFailure({
      error: 'cc-startup-death (≤3 msgs, no tool use) — Not logged in · Please run /login',
    });
    expect(r.cause).toBe('provider_auth_expired');
  });

  // cm:why the three branches that DISCARD the error text and write a sentence of their own are the whole exposure. Every other verdict is `reasonExcerpt`, i.e. the original text, which classifies on the second pass exactly as it did on the first.
  it('round-trips each verdict that replaces the error text rather than quoting it', () => {
    const verdicts = [
      'org/account spend limit → per-account failover with exhaustion memory',
      'usage/session limit → cross-device failover',
      'cc-startup-death (≤3 msgs, no tool use)',
    ];
    for (const verdict of verdicts) {
      expect(classifyFailure({ error: verdict }).cause).not.toBe('unclassified');
    }
  });
});

describe('the residue that stays unclassified on purpose', () => {
  it('leaves a CLI error that carries no detail unclassified rather than inventing a diagnosis', () => {
    const r = classifyFailure({ error: '[RESULT_ERROR] error_during_execution' });
    expect(r.cause).toBe('unclassified');
    expect(r.meta?.needsReview).toBe(true);
  });

  it('leaves a bare timeout unclassified — the named hops write their own token', () => {
    expect(classifyFailure({ error: 'Request stalled: operation timeout' }).cause).toBe(
      'unclassified',
    );
  });
});
