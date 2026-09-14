import { afterEach, describe, expect, it } from 'vitest';
import { clearRegisteredAudiences, registerAudience, registeredAudiences } from './audiences.js';
import { cellFor, clearRegisteredCells, registerCell, registeredCells } from './cells.js';
import { cellId, type MessageRefusal, problemsOf, renderRefusals } from './contract.js';
import { facts } from './facts.js';
import { screenMessage } from './screen.js';

const refusals = (v: ReturnType<typeof screenMessage>): readonly MessageRefusal[] =>
  v.ok ? [] : v.refusals;

afterEach(() => {
  clearRegisteredCells();
  clearRegisteredAudiences();
});

describe('a message has to name a pair, and the pair has to name a cell', () => {
  it('refuses a message with no intent, by name', () => {
    const v = screenMessage({ audience: 'role', intent: '' as 'ask', segments: ['hello'] });
    expect(v.ok).toBe(false);
    expect(refusals(v)[0]?.rule).toBe('cell-exists');
  });

  it('refuses a message with no audience, by name', () => {
    const v = screenMessage({ audience: '', intent: 'report', segments: ['hello'] });
    expect(v.ok).toBe(false);
    expect(refusals(v)[0]?.why).toContain('is not an audience this server knows');
  });

  it('refuses an audience nobody registered rather than admitting it', () => {
    const v = screenMessage({ audience: 'auditor', intent: 'report', segments: ['hello'] });
    expect(v.ok).toBe(false);
    expect(refusals(v)[0]?.why).toContain('"auditor" is not an audience this server knows');
  });

  it('refuses a known audience with an intent it declares no cell for', () => {
    registerAudience({ id: 'auditor', reader: 'an outside auditor' });
    const v = screenMessage({ audience: 'auditor', intent: 'ask', segments: ['hello'] });
    expect(v.ok).toBe(false);
    expect(refusals(v)[0]?.why).toContain('no rules are declared for intent "ask"');
  });

  it('resolves all four shipped cells', () => {
    for (const audience of ['role', 'public']) {
      for (const intent of ['ask', 'report'] as const) {
        expect(cellFor(audience, intent), `${audience}:${intent}`).toBeDefined();
      }
    }
  });

  it('marks public:ask reserved and every other shipped cell not', () => {
    const reserved = registeredCells()
      .filter((c) => c.reserved)
      .map((c) => c.id);
    expect(reserved).toEqual(['public:ask']);
  });
});

describe('a third audience is a row, not surgery', () => {
  it('screens a newly registered audience through the unchanged screen', () => {
    registerAudience({ id: 'auditor', reader: 'an outside auditor' });
    const cell = cellFor('role', 'report');
    if (!cell) throw new Error('role:report missing');
    registerCell({ ...cell, id: cellId('auditor', 'report'), audience: 'auditor' });

    expect(registeredAudiences().map((a) => a.id)).toContain('auditor');
    const passes = screenMessage({ audience: 'auditor', intent: 'report', segments: ['all well'] });
    expect(passes.ok).toBe(true);
    const breaks = screenMessage({
      audience: 'auditor',
      intent: 'report',
      segments: ['@all look at this'],
    });
    expect(problemsOf(breaks)[0]).toContain('addresses the whole room');
  });
});

describe('what a refusal carries', () => {
  it('names the rule, the shape and an example on every refusal', () => {
    const v = screenMessage({
      audience: 'role',
      intent: 'ask',
      segments: ['@all pick one'],
      facts: facts({}),
    });
    expect(v.ok).toBe(false);
    for (const r of refusals(v)) {
      expect(r.rule).not.toBe('');
      expect(r.shape).not.toBe('');
      expect(r.example).not.toBe('');
    }
  });

  it('quotes the fragment that broke the rule', () => {
    const v = screenMessage({ audience: 'role', intent: 'ask', segments: ['@here pick one'] });
    expect(refusals(v)[0]?.quote).toBe('@here');
  });

  it('renders a refusal with its rule, shape and example, so a bare "wrong format" is impossible', () => {
    const v = screenMessage({ audience: 'role', intent: 'ask', segments: ['@all pick one'] });
    const text = renderRefusals(refusals(v));
    expect(text).toContain('rule: no-room-broadcast');
    expect(text).toContain('shape:');
    expect(text).toContain('for example:');
  });

  it('carries no message text on either arm of the verdict', () => {
    const pass = screenMessage({ audience: 'role', intent: 'ask', segments: ['pick one'] });
    const fail = screenMessage({ audience: 'role', intent: 'ask', segments: ['@all pick one'] });
    expect(Object.keys(pass)).toEqual(['ok']);
    expect(Object.keys(fail).sort()).toEqual(['ok', 'refusals']);
    for (const r of refusals(fail)) {
      expect(Object.keys(r).sort()).toEqual(['example', 'quote', 'rule', 'shape', 'why']);
    }
  });
});

describe('every example a refusal offers actually obeys its own cell', () => {
  it.each(registeredCells().map((c) => [c.id, c] as const))(
    '%s offers only examples that pass it',
    (_id, cell) => {
      for (const rule of cell.rules) {
        const v = screenMessage({
          audience: cell.audience,
          intent: cell.intent,
          segments: [rule.example],
          facts: facts({ prefix: 'ISS', prefixes: ['ISS'] }),
        });
        expect({ rule: rule.id, problems: problemsOf(v) }).toEqual({
          rule: rule.id,
          problems: [],
        });
      }
    },
  );
});
