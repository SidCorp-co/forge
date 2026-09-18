/**
 * ISS-1070 — "one door per value", enumerated.
 *
 * `AGENT_CONFIG_DOORS` is prose until something walks it, and the property it states is invisible in
 * a green run: a seventh key declared with no door breaks nothing today and is unreachable forever
 * after. So both directions are asserted here, and so is the third pairing nothing else holds — the
 * retired-key table against the key list migration `0285` actually deletes, because a name in one
 * and not the other is either a key the door refuses while the column keeps it, or one the column
 * loses while the door still takes it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_CONFIG_DOORS,
  AGENT_CONFIG_KEYS,
  agentConfigSchema,
  RETIRED_AGENT_CONFIG_KEYS,
  refuseAgentConfigRecord,
} from './agent-config-schema.js';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/migrations/0285_agent_config_shadow_keys.sql', import.meta.url),
  ),
  'utf8',
);

/** The `retired_keys` / `declared_keys` arrays out of the migration's own DECLARE block. */
function migrationArray(name: string): string[] {
  const body = new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(MIGRATION);
  if (!body?.[1]) throw new Error(`0285 declares no ${name} array`);
  return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('agentConfig declared keys and their doors', () => {
  it('declares a door for every key the schema carries', () => {
    const undoored = AGENT_CONFIG_KEYS.filter((key) => !AGENT_CONFIG_DOORS[key]);
    expect(undoored).toEqual([]);
  });

  it('names no door for a key the schema does not carry', () => {
    const declared = new Set<string>(AGENT_CONFIG_KEYS);
    expect(Object.keys(AGENT_CONFIG_DOORS).filter((k) => !declared.has(k))).toEqual([]);
  });

  it('keeps the declared key set and the retired key set disjoint', () => {
    const declared = new Set<string>(AGENT_CONFIG_KEYS);
    expect(Object.keys(RETIRED_AGENT_CONFIG_KEYS).filter((k) => declared.has(k))).toEqual([]);
  });

  // cm:guard the migration's arrays are read out of the .sql file rather than restated here: a copy in this test would go green against a migration that says something else, which is the one failure this case exists to catch.
  it('deletes in 0285 exactly the keys the doors refuse by name', () => {
    expect(migrationArray('retired_keys').sort()).toEqual(
      Object.keys(RETIRED_AGENT_CONFIG_KEYS).sort(),
    );
  });

  it('spares in 0285 exactly the keys the schema declares', () => {
    expect(migrationArray('declared_keys').sort()).toEqual([...AGENT_CONFIG_KEYS].sort());
  });

  it('names the owning column in every retired key message', () => {
    const owners: Record<string, string> = {
      repoPath: 'projects.repo_path',
      baseBranch: 'projects.base_branch',
      productionBranch: 'projects.live_branch',
      activeDeviceId: 'projects.default_device_id',
      // cm:why the one retirement with no column: nothing owns it, and the message says what decides instead
      runnerFallback: 'pipelineConfig.states[*].runner',
    };
    const missing = Object.entries(owners).filter(
      ([key, owner]) => !RETIRED_AGENT_CONFIG_KEYS[key]?.includes(owner),
    );
    expect(missing).toEqual([]);
  });
});

/** Run the walk over one record and collect the messages it produced, path-first. */
function refusalsFor(record: unknown): string[] {
  const schema = z.unknown().superRefine((raw, ctx) => refuseAgentConfigRecord(raw, ctx));
  const result = schema.safeParse(record);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('refuseAgentConfigRecord', () => {
  it.each([
    ['repoPath', '/tmp/somewhere', 'projects.repo_path'],
    ['baseBranch', 'main', 'projects.base_branch'],
    ['productionBranch', 'main', 'projects.live_branch'],
    ['activeDeviceId', '85644100-e4f5-455a-9754-6af76c19e50a', 'projects.default_device_id'],
    ['runnerFallback', { type: 'claude-code' }, 'decides nothing'],
  ])('refuses the retired key %s naming what owns its value', (key, value, owner) => {
    const messages = refusalsFor({ [key]: value });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`agentConfig.${key}`);
    expect(messages[0]).toContain(owner);
  });

  it('refuses a declared key by naming the door that writes it', () => {
    const messages = refusalsFor({ systemPrompt: 'hello' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('`systemPrompt` field on `PATCH /api/projects/:id`');
  });

  it('refuses a key nothing declares rather than dropping it', () => {
    const messages = refusalsFor({ uxContractProfile: { rules: [] } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('agentConfig.uxContractProfile is not a key');
    expect(messages[0]).toContain('pipelineConfig, plugins');
  });

  it('answers every key of a record rather than only the first', () => {
    const messages = refusalsFor({ repoPath: '/x', plugins: [], whatIsThis: 1 });
    expect(messages).toHaveLength(3);
  });

  // cm:guard the bodies that carry NO key, which a per-key walk answers with nothing: `{}` and `[]` reached `updateProjectSchema`, were stripped, and left a 200 with the field dropped — the silent discard this refusal exists to remove, arrived at by the one shape that names nothing. Found by review of ISS-1070 rather than by a case, which is why each is its own row here.
  it.each([
    ['null', null],
    ['an empty record', {}],
    ['a list', []],
    ['a string', 'plugins'],
  ])('refuses agentConfig given as %s, which names no key at all', (_label, record) => {
    const messages = refusalsFor(record);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no longer a field on PATCH /api/projects/:id');
    expect(messages[0]).toContain('Clear each value through its own door');
  });

  // cm:guard the clearing guide names `pipelineConfig` as the one value with NO clear, because its door merges a patch onto the stored document and no request removes a key from it (measured on beta for ISS-1076). A message that promised a null-clear for every key would send the operator from this refusal to another one.
  it('does not promise a clear that pipelineConfig has no door for', () => {
    const message = refusalsFor(null)[0] ?? '';
    expect(message).toContain('`pipelineConfig` is the one value with no clear');
    expect(message).not.toMatch(/send .*`pipelineConfig`.* as null/);
  });

  it('skips a key whose message the caller already added', () => {
    const schema = z
      .unknown()
      .superRefine((raw, ctx) =>
        refuseAgentConfigRecord(raw, ctx, ['agentConfig'], new Set(['projectFacts'])),
      );
    const result = schema.safeParse({ projectFacts: {}, repoPath: '/x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toEqual(['agentConfig.repoPath']);
  });
});

describe('agentConfigSchema', () => {
  it('accepts a document holding every declared key', () => {
    const parsed = agentConfigSchema.safeParse({
      pipelineConfig: { enabled: true },
      plugins: [{ marketplace: 'SidCorp-co/forge-plugin', name: 'forge' }],
      personaStyle: 'terse',
      systemPrompt: 'answer in Vietnamese',
      rocketChatAnswerMode: 'agent',
      categories: ['bug', 'enhancement'],
    });
    expect(parsed.success).toBe(true);
  });

  // cm:guard the point of `.strict()`: a non-strict object STRIPS the key and answers success, which is the 200-and-silent-discard shape ISS-994 and ISS-1000 established and this schema exists to make unrepresentable. Without the assertion on `success`, the case passes either way.
  it('refuses a document holding an undeclared key rather than stripping it', () => {
    const parsed = agentConfigSchema.safeParse({ personaStyle: 'terse', uxContractProfile: {} });
    expect(parsed.success).toBe(false);
  });

  it('refuses a personaStyle past the cap that leaves room for migration 0245', () => {
    expect(agentConfigSchema.safeParse({ personaStyle: 'x'.repeat(4101) }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ personaStyle: 'x'.repeat(4100) }).success).toBe(true);
  });
});
