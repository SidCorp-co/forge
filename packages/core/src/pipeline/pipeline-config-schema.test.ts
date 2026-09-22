import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_DRIVER_STATUSES } from './autonomous-mode.js';
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
  it('accepts pipelineConfig fields', () => {
    const patch = { enabled: true };
    expect(pipelineConfigPatchSchema.parse(patch)).toEqual(patch);
  });

  // A patch key is an instruction, so a key this config does not have is refused by name
  // rather than dropped: under the old whole-document contract an unknown key was silently
  // discarded and the caller was answered 200 (ISS-1170).
  it.each([
    ['autoTriage', { enabled: true, autoTriage: true }],
    ['sessionGroups', { sessionGroups: { build: ['open'] } }],
    ['mode', { mode: 'staged' }],
    ['runnerFallback', { enabled: true, runnerFallback: ['claude-code'] }],
  ])('refuses the staged-era key `%s` by name', (key, patch) => {
    const out = pipelineConfigPatchSchema.safeParse(patch);
    expect(out.success).toBe(false);
    const message = out.error?.issues.map((i) => i.message).join(' ') ?? '';
    expect(message).toContain(`\`${key}\` is not a pipeline config key`);
  });

  it('names the keys it does have in that refusal', () => {
    const out = pipelineConfigPatchSchema.safeParse({ runnerFallback: [] });
    expect(out.error?.issues[0]?.message).toContain('intakeGate');
  });

  it('refuses the removed concurrency cap rather than echoing it back', () => {
    const out = pipelineConfigPatchSchema.safeParse({ enabled: true, maxConcurrentIssues: 4 });
    expect(out.success).toBe(false);
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

  it.each(AUTONOMOUS_DRIVER_STATUSES)('rejects the driver-owned status %s', (status) => {
    const out = pipelineConfigSchema.safeParse({ poolBacklog: { statuses: [status] } });
    expect(out.success).toBe(false);
  });

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

describe('githubIntake (ISS-1076)', () => {
  it('keeps the key it declares, so the setting reaches its reader', () => {
    const out = pipelineConfigSchema.safeParse({ githubIntake: { enabled: true } });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.githubIntake).toEqual({ enabled: true });
  });

  it('keeps an explicit false, which is not the same document as an absent key', () => {
    const out = pipelineConfigSchema.safeParse({ githubIntake: { enabled: false } });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.githubIntake).toEqual({ enabled: false });
  });

  it('gives an absent key no value of its own', () => {
    const out = pipelineConfigSchema.safeParse({});
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.githubIntake).toBeUndefined();
    expect('githubIntake' in out.data).toBe(false);
  });

  it('refuses a key the object does not declare rather than storing it beside enabled', () => {
    expect(
      pipelineConfigSchema.safeParse({ githubIntake: { enabled: true, notify: true } }).success,
    ).toBe(false);
  });

  it('refuses a non-boolean enabled, which a truthy string would otherwise open the door with', () => {
    expect(pipelineConfigSchema.safeParse({ githubIntake: { enabled: 'yes' } }).success).toBe(
      false,
    );
    expect(pipelineConfigSchema.safeParse({ githubIntake: {} }).success).toBe(false);
  });

  it('is independent of intakeGate, which answers the other question', () => {
    const out = pipelineConfigSchema.safeParse({
      githubIntake: { enabled: true },
      intakeGate: { enabled: false },
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.githubIntake?.enabled).toBe(true);
    expect(out.data.intakeGate?.enabled).toBe(false);
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

  // The patch schema judges SHAPE, and the value above is shaped like a patch; what refuses
  // it is the schema run over the merged document, which is where every value rule now lives.
  it('takes the same unknown key through the PATCH schema and refuses it on the merge', () => {
    const patch = { statusEntryCriteria: { closed: ['deploy_receipt'] } };
    expect(pipelineConfigPatchSchema.safeParse(patch).success).toBe(true);
    expect(pipelineConfigSchema.safeParse(patch).success).toBe(false);
  });

  it('leaves a document that declares nothing without the key at all', () => {
    const out = pipelineConfigSchema.parse({ enabled: true });
    expect('statusEntryCriteria' in out).toBe(false);
  });
});
