import { describe, expect, it } from 'vitest';
import {
  defaultStatesConfig,
  mergePipelineConfig,
  PIPELINE_CONFIG_DEFAULTS,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';

describe('pipelineConfigSchema', () => {
  it('accepts an empty document (all fields optional)', () => {
    expect(pipelineConfigSchema.parse({})).toEqual({});
  });

  it('drops unknown keys (legacy clarified, pipelineSteps)', () => {
    const legacy = {
      enabled: true,
      clarified: 'something',
      pipelineSteps: [{ status: 'open', skill: 'forge-triage' }],
      previewEnabled: false,
    };
    const out = pipelineConfigSchema.parse(legacy);
    expect(out).toEqual({ enabled: true });
    expect((out as Record<string, unknown>).clarified).toBeUndefined();
    expect((out as Record<string, unknown>).pipelineSteps).toBeUndefined();
  });

  it('silently drops legacy recovery keys (no longer surfaced)', () => {
    const legacy = {
      enabled: true,
      recoveryMaxAttempts: 5,
      recoveryWindowHours: 24,
      recoveryByFailureKind: { transient: 10 },
    };
    const out = pipelineConfigSchema.parse(legacy);
    expect(out).toEqual({ enabled: true });
  });
});

describe('PIPELINE_CONFIG_DEFAULTS', () => {
  it('parses cleanly through the schema', () => {
    expect(() => pipelineConfigSchema.parse(PIPELINE_CONFIG_DEFAULTS)).not.toThrow();
  });

  it('exposes states defaults with enabled=true (ISS-232 Phase 3 default flip)', () => {
    expect(PIPELINE_CONFIG_DEFAULTS.enabled).toBe(true);
    expect(PIPELINE_CONFIG_DEFAULTS.states).toBeDefined();
  });
});

describe('pipelineConfigPatchSchema', () => {
  // cm:why the patch schema IS `pipelineConfigSchema` — there are no patch-only extension fields, and the pair being one object is what stops a PATCH accepting a shape a GET can never return.
  it('accepts pipelineConfig fields', () => {
    const patch = { enabled: true };
    expect(pipelineConfigPatchSchema.parse(patch)).toEqual(patch);
  });

  // cm:guard ISS-897 removed these from the object literal, and the strip is what DELETES them from a stored document on the next save. A regression that re-adds one silently re-animates staged configuration on 38 projects, so assert the drop rather than the absence of an error.
  it('strips every staged key it used to accept', () => {
    const staged = {
      enabled: true,
      autoTriage: true,
      autoClarify: true,
      autoPlan: true,
      autoCode: true,
      autoReview: true,
      autoTest: true,
      autoFix: true,
      autoRelease: true,
      sessionGroups: { build: ['open'] },
      mergeStates: { baseBranch: 'awaiting_release', liveBranch: 'awaiting_release' },
      mode: 'staged',
      states: { open: { enabled: true, sessionGroup: 'build', skipComplexities: ['xs'] } },
    };
    expect(pipelineConfigPatchSchema.parse(staged)).toEqual({
      enabled: true,
      states: { open: { enabled: true } },
    });
  });

  it('silently drops legacy `runnerFallback` field (unknown keys ignored)', () => {
    // cm:why Zod's default `.object()` strips unknown keys rather than throwing. The behaviour stays "permissive on input, strict on output" so v1 patches replaying via the same endpoint don't 400 — the dropped field simply has no effect on the merged document.
    const out = pipelineConfigPatchSchema.parse({
      enabled: true,
      runnerFallback: ['claude-code'],
    });
    expect(out).toEqual({ enabled: true });
  });

  // cm:guard the strip is the DELETION MECHANISM for the removed concurrency cap — the schema drops unknown keys on parse, so a project's next settings save clears `maxConcurrentIssues` from the stored document. Migration 0205 does it for every project at once so the fleet is never half-stripped; this pins that the schema no longer answers with it.
  it('drops the removed concurrency cap rather than echoing it back', () => {
    const out = pipelineConfigPatchSchema.parse({ enabled: true, maxConcurrentIssues: 4 });
    expect(out).toEqual({ enabled: true });
  });
});

describe('statesConfigSchema (ISS-110)', () => {
  it('accepts valid IssueStatus keys', () => {
    const patch = {
      states: {
        open: { enabled: false, mode: 'auto' as const },
        needs_info: { enabled: true },
      },
    };
    expect(pipelineConfigSchema.parse(patch)).toEqual(patch);
  });

  it('rejects unknown status keys at the schema boundary', () => {
    // cm:why Review minor #3: prior `z.record(z.string(), ...)` accepted junk keys silently. Tighten to z.enum(issueStatuses) so typos surface as 400.
    const patch = {
      states: {
        not_a_status: { enabled: false },
      },
    };
    expect(() => pipelineConfigSchema.parse(patch)).toThrow();
  });
});

describe('stageConfigSchema per-state overrides', () => {
  it('accepts model, allowedTools, permissionMode, timeoutSeconds', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        open: {
          model: 'sonnet',
          allowedTools: ['Bash', 'mcp__forge__forge_issues'],
          permissionMode: 'acceptEdits',
          timeoutSeconds: 1800,
        },
      },
    });
    expect(parsed.states?.open?.model).toBe('sonnet');
    expect(parsed.states?.open?.allowedTools).toEqual(['Bash', 'mcp__forge__forge_issues']);
    expect(parsed.states?.open?.permissionMode).toBe('acceptEdits');
    expect(parsed.states?.open?.timeoutSeconds).toBe(1800);
  });

  // cm:guard ISS-1000 — the pair below is the whole retirement and neither half stands alone: the WRITE is refused by name so the removal is not a silent drop, and the stored document is still READ, because a canonical schema that refused a stored `skillName` would make every project holding one parse to `cfg = null` and dispatch nothing in silence. Same asymmetry ISS-994 established for `mode`.
  for (const stage of ['open', 'in_progress', 'needs_info', 'awaiting_release']) {
    it(`refuses a PATCH carrying states.${stage}.skillName`, () => {
      const result = pipelineConfigPatchSchema.safeParse({
        states: { [stage]: { skillName: 'forge-review' } },
      });
      expect(result.success).toBe(false);
      const issue = result.error?.issues.find(
        (i) => i.path.join('.') === `states.${stage}.skillName`,
      );
      expect(issue?.message).toContain('skillName selects nothing');
      expect(issue?.message).toContain('issue-flow');
    });
  }

  it('still parses a STORED document that carries skillName, dropping the key', () => {
    const parsed = pipelineConfigSchema.parse({
      states: { open: { skillName: 'forge-review', model: 'sonnet' } },
    });
    expect(parsed.states?.open).toEqual({ model: 'sonnet' });
  });

  it('accepts systemPrompt append/replace + extras', () => {
    const systemPrompt = { mode: 'replace', extras: 'CUSTOM RULES' } as const;
    const parsed = pipelineConfigSchema.parse({ states: { awaiting_release: { systemPrompt } } });
    expect(parsed.states?.awaiting_release?.systemPrompt).toEqual(systemPrompt);
  });

  it('rejects unknown systemPrompt mode', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { awaiting_release: { systemPrompt: { mode: 'merge' } } },
      }),
    ).toThrow();
  });

  it('caps systemPrompt.extras at 32_000 chars', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { awaiting_release: { systemPrompt: { extras: 'x'.repeat(32_001) } } },
      }),
    ).toThrow();
  });

  it('rejects replace mode with empty / null / whitespace extras (F12)', () => {
    for (const extras of ['', '   ', null] as const) {
      expect(() =>
        pipelineConfigSchema.parse({
          states: { awaiting_release: { systemPrompt: { mode: 'replace', extras } } },
        }),
      ).toThrow();
    }
  });

  it('accepts replace with real extras, and append with empty extras (a valid no-op)', () => {
    for (const systemPrompt of [
      { mode: 'replace', extras: 'ONLY THIS' },
      { mode: 'append', extras: '' },
    ]) {
      expect(() =>
        pipelineConfigSchema.parse({ states: { awaiting_release: { systemPrompt } } }),
      ).not.toThrow();
    }
  });

  it('accepts userPromptPolicy with all knobs', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        open: {
          userPromptPolicy: {
            includeFields: ['plan', 'acceptanceCriteria'],
            sessionContext: { depth: 5, fields: ['decisions', 'filesModified'] },
            fieldCaps: { plan: 20_000 },
            truncationStrategy: 'byte-cut',
          },
        },
      },
    });
    expect(parsed.states?.open?.userPromptPolicy?.includeFields).toEqual([
      'plan',
      'acceptanceCriteria',
    ]);
    expect(parsed.states?.open?.userPromptPolicy?.fieldCaps?.plan).toBe(20_000);
  });

  it('accepts every handoffs field that still exists', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        open: {
          userPromptPolicy: {
            handoffs: {
              enabled: true,
              injectFromSteps: ['triage', 'plan'],
              fallbackToRawIssueFieldIfMissing: true,
            },
          },
        },
      },
    });
    expect(parsed.states?.open?.userPromptPolicy?.handoffs?.enabled).toBe(true);
    expect(parsed.states?.open?.userPromptPolicy?.handoffs?.injectFromSteps).toEqual([
      'triage',
      'plan',
    ]);
  });

  it.each(['missingMarkerPolicy', 'requireHandoffWrite'])(
    'rejects handoffs.%s — the gate knobs are gone, not merely unread',
    (key) => {
      expect(() =>
        pipelineConfigSchema.parse({
          states: { open: { userPromptPolicy: { handoffs: { [key]: 'anything' } } } },
        }),
      ).toThrow();
    },
  );

  it('does NOT cap fieldCaps server-side (D3: operator owns budget)', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { open: { userPromptPolicy: { fieldCaps: { description: 1_000_000 } } } },
      }),
    ).not.toThrow();
  });

  it('accepts budget caps', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        open: { budget: { perRunUsd: 2.5, perMonthUsd: 100 } },
      },
    });
    expect(parsed.states?.open?.budget).toEqual({ perRunUsd: 2.5, perMonthUsd: 100 });
  });

  it('accepts budget action enum values', () => {
    for (const action of ['pause', 'warn'] as const) {
      const parsed = pipelineConfigSchema.parse({
        states: { open: { budget: { perMonthUsd: 50, action } } },
      });
      expect(parsed.states?.open?.budget?.action).toBe(action);
    }
  });

  it('rejects an unknown budget.action value', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { open: { budget: { perMonthUsd: 50, action: 'foo' } } },
      }),
    ).toThrow();
  });
});

describe('resume policy', () => {
  // cm:guard `maxResumeReopenCycles` was dropped from this schema by ISS-895 and must stay out. The schema STRIPS unknown keys, so re-adding the assertion without re-adding the key would fail here rather than silently — but re-adding the KEY is the real risk: it would restore a settings knob backing a bound that reads `reopen_count`, a column this lane never moves.
  it('accepts a non-negative maxResumeTokens, 0 included, which disables the gate', () => {
    for (const maxResumeTokens of [200_000, 0]) {
      expect(pipelineConfigSchema.parse({ maxResumeTokens }).maxResumeTokens).toBe(maxResumeTokens);
    }
  });

  it('rejects negative maxResumeTokens', () => {
    expect(() => pipelineConfigSchema.parse({ maxResumeTokens: -1 })).toThrow();
  });

  it('strips maxResumeReopenCycles rather than carrying a knob nothing reads', () => {
    const parsed = pipelineConfigSchema.parse({ maxResumeReopenCycles: 5 }) as Record<
      string,
      unknown
    >;
    expect(parsed.maxResumeReopenCycles).toBeUndefined();
  });

  it('maxResumeTokens is absent (undefined) when not configured', () => {
    expect(pipelineConfigSchema.parse({ enabled: true }).maxResumeTokens).toBeUndefined();
  });
});

// ISS-1071 rule 7 moved this check off the canonical schema and onto the WRITE schema. The pair is
// asymmetric on purpose and the asymmetry is the whole assertion: four control-plane readers
// (`devices/admissible.ts`, `pipeline/autonomous-project.ts`, `pipeline/orchestrator.ts`,
// `pipeline/pipeline-config-service.ts`) `safeParse` a STORED document and take a silent branch on
// failure, so a name check on the read side turns one stale document into a project that dispatches
// nothing and reports nothing — the ISS-807 shape. A write is told what does not reach; a read of
// something already stored is never refused.
describe('mcpServers validation (ISS-623 W1 / ISS-1071 rule 7)', () => {
  it('the WRITE schema rejects an unknown true-shorthand at the project default', () => {
    expect(() => pipelineConfigPatchSchema.parse({ mcpServers: { shop: true } })).toThrow(
      /mcpServers entry.*shop.*not a known catalog server/,
    );
  });

  it('the WRITE schema rejects an unknown true-shorthand per-state', () => {
    expect(() =>
      pipelineConfigPatchSchema.parse({
        states: { awaiting_release: { mcpServers: { shp: true } } },
      }),
    ).toThrow(/mcpServers entry.*shp.*not a known catalog server/);
  });

  it('the WRITE schema now rejects a PROVIDER name, and says where the switch moved to', () => {
    // The key change ISS-1038 is folded in for: `epodsystem: true` used to be the legal way to let
    // an agent use an integration. It is not a server name any more, and the refusal has to send
    // the operator to the binding rather than leaving them to find a second settings tab.
    expect(() => pipelineConfigPatchSchema.parse({ mcpServers: { epodsystem: true } })).toThrow(
      /agent-access switch on that integration's binding/,
    );
    expect(() => pipelineConfigPatchSchema.parse({ mcpServers: { epodsystem_store_a: true } })).toThrow(
      /not a known catalog server/,
    );
  });

  it('the READ schema refuses NONE of them, so a stored document still parses', () => {
    // Every project that stored a sentinel before this deploy reads back intact. If this goes red,
    // the check has crept back onto the canonical schema and those projects go dark in silence.
    for (const doc of [
      { mcpServers: { epodsystem: true } },
      { mcpServers: { epodsystem_store_a: true } },
      { mcpServers: { shop: true } },
      { states: { awaiting_release: { mcpServers: { shp: true } } } },
    ]) {
      expect(() => pipelineConfigSchema.parse(doc)).not.toThrow();
    }
  });

  it('both schemas accept a known catalog name', () => {
    expect(pipelineConfigSchema.parse({ mcpServers: { playwright: true } }).mcpServers).toEqual({
      playwright: true,
    });
    expect(pipelineConfigPatchSchema.parse({ mcpServers: { playwright: true } }).mcpServers).toEqual(
      { playwright: true },
    );
  });

  it('object-valued custom specs and false/null opt-outs pass both, unchanged', () => {
    const doc = {
      mcpServers: {
        custom: { type: 'stdio', command: 'foo', args: [], env: {} },
        disabled: false,
        cleared: null,
      },
    };
    expect(pipelineConfigSchema.parse(doc).mcpServers).toEqual(doc.mcpServers);
    expect(pipelineConfigPatchSchema.parse(doc).mcpServers).toEqual(doc.mcpServers);
  });
});

describe('defaultStatesConfig (ISS-581)', () => {
  it('ships disallowedTools for open/needs_info/released', () => {
    const config = defaultStatesConfig();
    const EXPECTED = [
      'CronCreate',
      'CronDelete',
      'CronList',
      'Workflow',
      'RemoteTrigger',
      'ScheduleWakeup',
    ];
    expect(config.open?.disallowedTools).toEqual(expect.arrayContaining(EXPECTED));
    expect(config.needs_info?.disallowedTools).toEqual(expect.arrayContaining(EXPECTED));
    expect(config.awaiting_release?.disallowedTools).toEqual(expect.arrayContaining(EXPECTED));
    expect(config.in_progress?.disallowedTools).toEqual(expect.arrayContaining(EXPECTED));
  });
});

describe('mergePipelineConfig', () => {
  it('merges patch onto current, preserving unknown keys for round-trip', () => {
    const current = { enabled: false, clarified: 'legacy', autoTriage: false };
    const patch = { enabled: true, autoTriage: true };
    const merged = mergePipelineConfig(current, patch);
    expect(merged).toEqual({ enabled: true, clarified: 'legacy', autoTriage: true });
  });

  it('handles null current', () => {
    expect(mergePipelineConfig(null, { enabled: true })).toEqual({ enabled: true });
  });

  it('round-trips the top-level mcpServers project-default through parse + merge', () => {
    const doc = {
      enabled: true,
      mcpServers: {
        playwright: true,
        custom: { type: 'stdio', command: 'foo', args: [], env: {} },
      },
    };
    const parsed = pipelineConfigSchema.parse(doc);
    expect(parsed.mcpServers).toEqual(doc.mcpServers);
    const merged = mergePipelineConfig({ enabled: false }, parsed);
    expect((merged as { mcpServers?: unknown }).mcpServers).toEqual(doc.mcpServers);
  });
});

// cm:why ISS-917 — per-project pool admission. The schema is the only place both transports (REST `PATCH /pipeline-config` and MCP `forge_config`) share, so what it refuses is what neither can store.
describe('poolBacklog (ISS-917)', () => {
  it('is optional — an empty document still parses to {} (no backlog, no behaviour change)', () => {
    const out = pipelineConfigSchema.parse({ enabled: true });
    expect(out.poolBacklog).toBeUndefined();
  });

  it('accepts statuses no driver owns', () => {
    const out = pipelineConfigSchema.parse({
      poolBacklog: { statuses: ['draft', 'on_hold', 'waiting'], limit: 5 },
    });
    expect(out.poolBacklog).toEqual({ statuses: ['draft', 'on_hold', 'waiting'], limit: 5 });
  });

  // cm:guard AC2 — the driver statuses are the ones that already carry a run and a job, so a backlog row at one could never be promoted. Offering them would be a menu of values `promoteFromBacklog` refuses as `issue_busy` forever.
  it.each(['open', 'in_progress', 'needs_info', 'closed', 'dropped'])(
    'rejects the driver-owned status %s',
    (status) => {
      const out = pipelineConfigSchema.safeParse({ poolBacklog: { statuses: [status] } });
      expect(out.success).toBe(false);
    },
  );

  it('rejects an unknown key inside poolBacklog (strict)', () => {
    const out = pipelineConfigSchema.safeParse({
      poolBacklog: { statuses: ['draft'], cap: 3 },
    });
    expect(out.success).toBe(false);
  });

  it('rejects a limit outside 1..100', () => {
    expect(
      pipelineConfigSchema.safeParse({ poolBacklog: { statuses: ['draft'], limit: 0 } }).success,
    ).toBe(false);
    expect(
      pipelineConfigSchema.safeParse({ poolBacklog: { statuses: ['draft'], limit: 101 } }).success,
    ).toBe(false);
  });

  // cm:guard AC3/B5 — the refusal must NAME both settings. A message that said only "invalid value" would send an operator to the status list looking for a typo in a value that is, on its own, perfectly legal.
  it('refuses intakeGate.enabled + draft together, naming both settings', () => {
    const out = pipelineConfigSchema.safeParse({
      intakeGate: { enabled: true },
      poolBacklog: { statuses: ['draft'] },
    });
    expect(out.success).toBe(false);
    if (out.success) return;
    const msg = out.error.issues.map((i) => i.message).join(' ');
    expect(msg).toContain('intakeGate');
    expect(msg).toContain('draft');
    expect(out.error.issues[0]?.path).toEqual(['poolBacklog', 'statuses']);
  });

  it('allows intakeGate.enabled beside a NON-draft backlog status', () => {
    const out = pipelineConfigSchema.safeParse({
      intakeGate: { enabled: true },
      poolBacklog: { statuses: ['on_hold'] },
    });
    expect(out.success).toBe(true);
  });

  it('allows draft when the intake gate is off', () => {
    const out = pipelineConfigSchema.safeParse({
      intakeGate: { enabled: false },
      poolBacklog: { statuses: ['draft'] },
    });
    expect(out.success).toBe(true);
  });
});

describe('statusEntryCriteria (ISS-959)', () => {
  it('accepts a declaration whose keys are statuses and whose values are implemented criteria', () => {
    const out = pipelineConfigSchema.safeParse({
      statusEntryCriteria: { closed: ['plan', 'release_note'], developed: ['work_evidence'] },
    });
    expect(out.success).toBe(true);
    expect(out.data?.statusEntryCriteria?.closed).toEqual(['plan', 'release_note']);
  });

  it('refuses a criterion key core does not implement, so a declaration cannot silently check nothing', () => {
    const out = pipelineConfigSchema.safeParse({
      statusEntryCriteria: { closed: ['plan', 'deploy_receipt'] },
    });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['statusEntryCriteria', 'closed', 1]);
  });

  it('refuses a key that is not an issue status', () => {
    const out = pipelineConfigSchema.safeParse({ statusEntryCriteria: { shipped: ['plan'] } });
    expect(out.success).toBe(false);
  });

  it('refuses an empty criterion list — a status declaring nothing says so by being absent', () => {
    const out = pipelineConfigSchema.safeParse({ statusEntryCriteria: { closed: [] } });
    expect(out.success).toBe(false);
  });

  it('refuses the same unknown key through the PATCH schema the config route validates with', () => {
    const out = pipelineConfigPatchSchema.safeParse({
      statusEntryCriteria: { closed: ['deploy_receipt'] },
    });
    expect(out.success).toBe(false);
  });

  it('leaves a document that declares nothing without the key at all', () => {
    const out = pipelineConfigSchema.parse({ enabled: true });
    expect('statusEntryCriteria' in out).toBe(false);
  });
});
