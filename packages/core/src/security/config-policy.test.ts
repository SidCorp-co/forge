import { describe, expect, it } from 'vitest';
import { validateStagePolicy } from './config-policy.js';

const clean = (): import('../pipeline/pipeline-config-schema.js').StageConfig => ({});

describe('validateStagePolicy — R5: bypassPermissions without denylist (ISS-531)', () => {
  it('warns when bypassPermissions is set and disallowedTools is absent', () => {
    const findings = validateStagePolicy(
      'approved',
      { permissionMode: 'bypassPermissions' },
      'sonnet',
    );
    const f = findings.find((x) => x.rule === 'policy.bypass-no-denylist');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warn');
  });

  it('warns when bypassPermissions is set and disallowedTools is empty', () => {
    const findings = validateStagePolicy(
      'approved',
      { permissionMode: 'bypassPermissions', disallowedTools: [] },
      'sonnet',
    );
    const f = findings.find((x) => x.rule === 'policy.bypass-no-denylist');
    expect(f).toBeDefined();
  });

  it('is clean when bypassPermissions has a non-empty denylist', () => {
    const findings = validateStagePolicy(
      'approved',
      { permissionMode: 'bypassPermissions', disallowedTools: ['Bash'] },
      'sonnet',
    );
    expect(findings.filter((x) => x.rule === 'policy.bypass-no-denylist')).toHaveLength(0);
  });

  it('is clean when permissionMode is not bypassPermissions', () => {
    const findings = validateStagePolicy('approved', { permissionMode: 'default' }, 'sonnet');
    expect(findings.filter((x) => x.rule === 'policy.bypass-no-denylist')).toHaveLength(0);
  });
});

describe('validateStagePolicy — R6: no-model (ISS-535)', () => {
  it('warns when no model set AND status is not in the default table', () => {
    // 'custom' is NOT in DEFAULT_STAGE_MODELS, so defaultModel is null
    const findings = validateStagePolicy('custom', clean(), null);
    const f = findings.find((x) => x.rule === 'policy.no-model');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warn');
  });

  it('is clean when no model set BUT status is in the default table', () => {
    // 'approved' is in DEFAULT_STAGE_MODELS (resolves to 'sonnet')
    const findings = validateStagePolicy('approved', clean(), 'sonnet');
    expect(findings.filter((x) => x.rule === 'policy.no-model')).toHaveLength(0);
  });

  it('is clean when model is explicitly set regardless of defaultModel', () => {
    const findings = validateStagePolicy('custom', { model: 'opus' }, null);
    expect(findings.filter((x) => x.rule === 'policy.no-model')).toHaveLength(0);
  });
});

describe('validateStagePolicy — R7: broad-allowlist', () => {
  it('warns when allowedTools has more than 50 entries', () => {
    const tools = Array.from({ length: 51 }, (_, i) => `tool_${i}`);
    const findings = validateStagePolicy('approved', { allowedTools: tools }, 'sonnet');
    const f = findings.find((x) => x.rule === 'policy.broad-allowlist');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warn');
  });

  it('is clean with exactly 50 entries', () => {
    const tools = Array.from({ length: 50 }, (_, i) => `tool_${i}`);
    const findings = validateStagePolicy('approved', { allowedTools: tools }, 'sonnet');
    expect(findings.filter((x) => x.rule === 'policy.broad-allowlist')).toHaveLength(0);
  });

  it('is clean with a small allowlist', () => {
    const findings = validateStagePolicy('approved', { allowedTools: ['Read', 'Edit'] }, 'sonnet');
    expect(findings.filter((x) => x.rule === 'policy.broad-allowlist')).toHaveLength(0);
  });

  it('is clean when allowedTools is null', () => {
    const findings = validateStagePolicy('approved', { allowedTools: null }, 'sonnet');
    expect(findings.filter((x) => x.rule === 'policy.broad-allowlist')).toHaveLength(0);
  });
});

describe('validateStagePolicy — clean stage', () => {
  it('returns no findings for a well-configured stage', () => {
    const findings = validateStagePolicy(
      'approved',
      {
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Bash', 'Write'],
        allowedTools: Array.from({ length: 10 }, (_, i) => `tool_${i}`),
      },
      'sonnet',
    );
    expect(findings).toHaveLength(0);
  });
});
