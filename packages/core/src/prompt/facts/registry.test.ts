import {
  SKILL_FACT_CATEGORIES,
  SKILL_FACT_NAMESPACES,
  SKILL_FACT_SCOPES,
  SKILL_FACT_TIERS,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import {
  FORGE_FACTS,
  OPERATING_AFFORDANCES_TEXT,
  getFact,
  listFacts,
  renderFact,
} from './registry.js';

describe('forge facts registry', () => {
  it('has unique fact ids', () => {
    const ids = FORGE_FACTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every fact renders non-empty text', () => {
    for (const fact of FORGE_FACTS) {
      expect(fact.render({ projectId: 'p', stage: 'plan' }).trim().length).toBeGreaterThan(0);
    }
  });

  it('exactly two mandatory facts (pipeline-rules + mcp-tool-reference)', () => {
    const mandatory = listFacts({ tier: 'mandatory' })
      .map((f) => f.id)
      .sort();
    expect(mandatory).toEqual(['mcp-tool-reference', 'pipeline-rules']);
  });

  it('pipeline-rules keeps the load-bearing invariants', () => {
    const text = renderFact('pipeline-rules') ?? '';
    expect(text.startsWith('## Pipeline Rules')).toBe(true);
    expect(text).toContain('Status LAST');
    expect(text).toContain('Decompose is system-owned');
    // The project-resolved ladder section takes precedence over the inline
    // default chain — guards against the two drifting silently (F1).
    expect(text).toContain('### Status ladder');
    expect(text).toContain('OVERRIDES the default');
    // Step check-in is the mandated first action (forge_step_start tool).
    expect(text).toContain('forge_step_start');
    expect(renderFact('mcp-tool-reference')).toContain('forge_step_start');
  });

  // AC5 token evidence (measured via renderFact + estimateTokens, no new
  // instrumentation): the mcp-tool-reference block grew 735 -> 766 estTokens
  // (+31, +111 chars) for this one bullet. A connected provider with a seeded
  // capability guide (e.g. coolify) adds another ~12 estTokens to its
  // preamble integrations bullet; providers without one are unaffected. On a
  // representative full pipeline preamble (pipeline-rules + tool-reference +
  // forge-facts + a per-stage state block, ~4090 estTokens) that is a ~0.8%
  // total growth in the common case and ~1.05% in the worst case (an
  // integration with a guide connected) — see FORGE_MCP_INSTRUCTIONS' own
  // guardrail test for the CLI-side number (net -77 chars, well under +50).
  it('mcp-tool-reference names forge_guide + the public /api/guides pointer (ISS-746)', () => {
    const text = renderFact('mcp-tool-reference') ?? '';
    expect(text).toContain('forge_guide');
    expect(text).toContain('/api/guides');
  });

  it('pipeline-rules carries the Operating affordances table + red flags (ISS-541)', () => {
    const text = renderFact('pipeline-rules') ?? '';
    // The canonical affordances block is appended into the mandatory
    // pipeline-rules so every job preamble teaches affordances as
    // trigger → tool → red-flag (not a noun-list).
    expect(text).toContain('## Operating affordances');
    expect(text).toContain(OPERATING_AFFORDANCES_TEXT);
    // The five affordances the issue requires + the red-flags list.
    expect(text).toContain('set_dependency kind:blocks');
    expect(text).toContain('draft');
    expect(text).toContain('forge_memory.search');
    expect(text).toContain('Forge red flags:');
    expect(text).toContain('docs/guides/forge-affordances.md');
  });

  it('Operating affordances names all six Forge red flags (criterion 4)', () => {
    for (const flag of [
      'prose-deps',
      'open-as-note',
      'wholesale-config-clobber',
      'skip-recall',
      'on_hold-from-draft',
      'fix-by-hand-and-forget',
    ]) {
      expect(OPERATING_AFFORDANCES_TEXT).toContain(flag);
    }
  });

  it('issue-bound facts are scoped away from pm jobs via appliesTo', () => {
    for (const id of ['status-ladder', 'comment-authoring', 'handoff']) {
      const fact = getFact(id);
      expect(fact?.appliesTo, id).toBeDefined();
      expect(fact?.appliesTo, id).not.toContain('pm');
    }
    // handoff only applies where a payload schema exists.
    expect(getFact('handoff')?.appliesTo).not.toContain('release');
    expect(getFact('handoff')?.appliesTo).toContain('fix');
  });

  it('status-ladder is project-resolved from ctx.ladder', () => {
    const resolved = renderFact('status-ladder', {
      projectId: 'p',
      ladder: ['open', 'confirmed', 'developed', 'testing', 'released'],
    });
    expect(resolved).toContain('open → confirmed → developed → testing → released');
    // Falls back to the default ladder when none is supplied.
    expect(renderFact('status-ladder')).toContain('open → confirmed → clarified');
  });

  it('handoff fact renders the per-stage payload keys', () => {
    expect(renderFact('handoff', { stage: 'plan' })).toContain('planSummary');
    expect(renderFact('handoff', { stage: 'review' })).toContain('verdict');
    // Unknown/absent stage degrades to the generic instruction.
    expect(renderFact('handoff', { stage: 'pm' })).toContain('forge_step_handoff.write');
  });

  it('relations fact states the real kinds and warns off invented names', () => {
    const text = renderFact('relations') ?? '';
    expect(text).toContain('blocks');
    expect(text).toContain('decomposes');
    expect(text).toContain('blocked_by'); // mentioned only to warn it is NOT valid
    expect(text).toContain('not valid kinds');
  });

  it('every fact conforms to the @forge/contracts enum tuples (parity)', () => {
    for (const f of FORGE_FACTS) {
      expect(SKILL_FACT_CATEGORIES).toContain(f.category);
      expect(SKILL_FACT_TIERS).toContain(f.tier);
      expect(SKILL_FACT_SCOPES).toContain(f.scope);
      expect(SKILL_FACT_NAMESPACES).toContain(f.namespace);
    }
  });

  it('getFact returns undefined for unknown ids', () => {
    expect(getFact('nope')).toBeUndefined();
    expect(renderFact('nope')).toBeUndefined();
  });
});
