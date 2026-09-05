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
      mergeStates: { baseBranch: 'released', productionBranch: 'released' },
      mode: 'staged',
      states: { open: { enabled: true, sessionGroup: 'build', skipComplexities: ['xs'] } },
    };
    expect(pipelineConfigPatchSchema.parse(staged)).toEqual({
      enabled: true,
      states: { open: { enabled: true } },
    });
  });

  it('silently drops legacy `runnerFallback` field (unknown keys ignored)', () => {
    // Zod's default `.object()` strips unknown keys rather than throwing.
    // The behaviour stays "permissive on input, strict on output" so v1
    // patches replaying via the same endpoint don't 400 — the dropped
    // field simply has no effect on the merged document.
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
    // Review minor #3: prior `z.record(z.string(), ...)` accepted junk keys
    // silently. Tighten to z.enum(issueStatuses) so typos surface as 400.
    const patch = {
      states: {
        not_a_status: { enabled: false },
      },
    };
    expect(() => pipelineConfigSchema.parse(patch)).toThrow();
  });
});

describe('stageConfigSchema per-state overrides', () => {
  it('accepts skillName, model, allowedTools, permissionMode, timeoutSeconds', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        open: {
          skillName: 'forge-review',
          model: 'sonnet',
          allowedTools: ['Bash', 'mcp__forge__forge_issues'],
          permissionMode: 'acceptEdits',
          timeoutSeconds: 1800,
        },
      },
    });
    expect(parsed.states?.open?.skillName).toBe('forge-review');
    expect(parsed.states?.open?.model).toBe('sonnet');
    expect(parsed.states?.open?.allowedTools).toEqual(['Bash', 'mcp__forge__forge_issues']);
    expect(parsed.states?.open?.permissionMode).toBe('acceptEdits');
    expect(parsed.states?.open?.timeoutSeconds).toBe(1800);
  });

  it('accepts systemPrompt append/replace + extras', () => {
    const parsed = pipelineConfigSchema.parse({
      states: {
        released: {
          systemPrompt: { mode: 'replace', extras: 'CUSTOM RULES' },
        },
      },
    });
    expect(parsed.states?.released?.systemPrompt).toEqual({
      mode: 'replace',
      extras: 'CUSTOM RULES',
    });
  });

  it('rejects unknown systemPrompt mode', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { released: { systemPrompt: { mode: 'merge' } } },
      }),
    ).toThrow();
  });

  it('caps systemPrompt.extras at 32_000 chars', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { released: { systemPrompt: { extras: 'x'.repeat(32_001) } } },
      }),
    ).toThrow();
  });

  it('rejects replace mode with empty / null / whitespace extras (F12)', () => {
    for (const extras of ['', '   ', null] as const) {
      expect(() =>
        pipelineConfigSchema.parse({
          states: { released: { systemPrompt: { mode: 'replace', extras } } },
        }),
      ).toThrow();
    }
  });

  it('accepts replace mode when extras has real content', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { released: { systemPrompt: { mode: 'replace', extras: 'ONLY THIS' } } },
      }),
    ).not.toThrow();
  });

  it('accepts append mode with empty extras (no-op but valid)', () => {
    expect(() =>
      pipelineConfigSchema.parse({
        states: { released: { systemPrompt: { mode: 'append', extras: '' } } },
      }),
    ).not.toThrow();
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
    // 1 million chars — silly but allowed.
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
    const parsedPause = pipelineConfigSchema.parse({
      states: { open: { budget: { perMonthUsd: 50, action: 'pause' } } },
    });
    expect(parsedPause.states?.open?.budget?.action).toBe('pause');
    const parsedWarn = pipelineConfigSchema.parse({
      states: { open: { budget: { perMonthUsd: 50, action: 'warn' } } },
    });
    expect(parsedWarn.states?.open?.budget?.action).toBe('warn');
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
  it('accepts maxResumeTokens as an optional non-negative integer', () => {
    expect(pipelineConfigSchema.parse({ maxResumeTokens: 200_000 }).maxResumeTokens).toBe(200_000);
  });

  it('accepts 0 for maxResumeTokens (gate disabled)', () => {
    expect(pipelineConfigSchema.parse({ maxResumeTokens: 0 }).maxResumeTokens).toBe(0);
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

describe('mcpServers validation (ISS-623 W1)', () => {
  it('accepts known catalog + integration true-sentinels at the project default', () => {
    const parsed = pipelineConfigSchema.parse({
      mcpServers: { epodsystem: true, playwright: true },
    });
    expect(parsed.mcpServers).toEqual({ epodsystem: true, playwright: true });
  });

  it('accepts a labeled epodsystem sentinel (epodsystem_<label>)', () => {
    const parsed = pipelineConfigSchema.parse({
      mcpServers: { epodsystem_store_a: true },
    });
    expect(parsed.mcpServers).toEqual({ epodsystem_store_a: true });
  });

  it('accepts object-valued custom specs and false/null opt-outs unchanged', () => {
    const doc = {
      mcpServers: {
        custom: { type: 'stdio', command: 'foo', args: [], env: {} },
        disabled: false,
        cleared: null,
      },
    };
    const parsed = pipelineConfigSchema.parse(doc);
    expect(parsed.mcpServers).toEqual(doc.mcpServers);
  });

  it('rejects an unknown true-sentinel name at the project default', () => {
    expect(() => pipelineConfigSchema.parse({ mcpServers: { shop: true } })).toThrow(
      /mcpServers entry.*shop.*not a known catalog server/,
    );
  });

  it('rejects an unknown true-sentinel name per-state', () => {
    expect(() =>
      pipelineConfigSchema.parse({ states: { released: { mcpServers: { shp: true } } } }),
    ).toThrow(/mcpServers entry.*shp.*not a known catalog server/);
  });

  it('accepts a known true-sentinel name per-state', () => {
    const parsed = pipelineConfigSchema.parse({
      states: { released: { mcpServers: { playwright: true, epodsystem: true } } },
    });
    expect(parsed.states?.released?.mcpServers).toEqual({ playwright: true, epodsystem: true });
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
    expect(config.released?.disallowedTools).toEqual(expect.arrayContaining(EXPECTED));
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
