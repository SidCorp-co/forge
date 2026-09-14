/**
 * ISS-1008 — the probe reads a finished turn: the reply as delivered, and the
 * records of what the turn's calls actually did. The case that named it is
 * `the measured incident`; every other case here is a way the probe could cry
 * wolf, because a log-only detector earns its hard refusal by its silence.
 */

import { describe, expect, it } from 'vitest';
import { detectStateConfab } from './confab.js';
import type { ToolCallRecord } from './run-turn-core.js';

function call(over: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    name: 'forge_issues',
    arguments: '{}',
    round: 1,
    isError: false,
    durationMs: 1,
    resultPreview: '',
    ...over,
  };
}

const REFUSED_UPDATE = call({
  arguments: JSON.stringify({ action: 'update', documentId: 'ISS-2', data: { status: 'open' } }),
  isError: true,
  resultPreview: 'that status dispatches a pipeline run — leave that transition to a human',
});

describe('the measured incident', () => {
  it('catches a reply claiming the write its own tool result refused', () => {
    const probe = detectStateConfab('ISS-2 has been set to open.', [REFUSED_UPDATE]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims).toHaveLength(1);
    expect(probe.claims[0]?.subject).toBe('ISS-2');
    expect(probe.claims[0]?.tool).toBe('forge_issues');
    expect(probe.claims[0]?.sentence).toContain('ISS-2');
  });

  // cm:guard the door with live traffic answers in Vietnamese — carried since ISS-1007 by that project's `agentConfig.personaStyle` rather than by `rocketChatPersona` — so an English-only matcher would report ~0 there and read as "the defect is rare" rather than "nobody looked" (ISS-1008)
  it('catches the same claim written in Vietnamese', () => {
    // cm:ignore CM001 — the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only.
    const probe = detectStateConfab('ISS-2 đã được chuyển sang open.', [REFUSED_UPDATE]); // i18n-allow: that door's own replies are written this way, so the probe is judged on one
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.subject).toBe('ISS-2');
  });
});

describe('a result wins over prose', () => {
  it('says nothing when the same ref was written successfully in the same turn', () => {
    const landed = call({
      arguments: JSON.stringify({
        action: 'update',
        documentId: 'ISS-2',
        data: { priority: 'high' },
      }),
    });
    expect(detectStateConfab('ISS-2 has been updated.', [REFUSED_UPDATE, landed]).suspected).toBe(
      false,
    );
  });

  it('says nothing when every write landed', () => {
    const landed = call({
      arguments: JSON.stringify({ action: 'create', data: { title: 'x' } }),
    });
    expect(detectStateConfab('I have created the issue.', [landed]).suspected).toBe(false);
  });
});

describe('the claim is read per sentence', () => {
  it('does not let a success phrase answer for a ref in another sentence', () => {
    const probe = detectStateConfab('I have updated the label. ISS-2 is the one you asked about.', [
      REFUSED_UPDATE,
    ]);
    expect(probe.suspected).toBe(false);
  });

  // cm:guard a chat reply is often a bullet list with no full stops; joining those lines would let one bullet's success phrase answer for another bullet's ref, which is the over-firing the newline split exists to stop
  it('treats each line of a bulleted reply as its own sentence', () => {
    const probe = detectStateConfab('- Updated the title\n- ISS-2 is still open for review', [
      REFUSED_UPDATE,
    ]);
    expect(probe.suspected).toBe(false);
  });
});

describe('what is not a claim about state', () => {
  it('ignores a refused READ, which asserts nothing about a row', () => {
    const refusedGet = call({
      arguments: JSON.stringify({ action: 'get', documentId: 'ISS-2' }),
      isError: true,
    });
    expect(detectStateConfab('ISS-2 has been set to open.', [refusedGet]).suspected).toBe(false);
  });

  it('ignores a refused write whose ref the reply never names', () => {
    expect(detectStateConfab('ISS-9 has been set to open.', [REFUSED_UPDATE]).suspected).toBe(
      false,
    );
  });

  it('ignores a reply that claims nothing landed', () => {
    expect(
      detectStateConfab('I could not set ISS-2 to open — a human has to make that move.', [
        REFUSED_UPDATE,
      ]).suspected,
    ).toBe(false);
  });

  it('says nothing when no call was refused', () => {
    const landed = call({
      arguments: JSON.stringify({ action: 'update', documentId: 'ISS-2' }),
    });
    expect(detectStateConfab('ISS-2 has been set to open.', [landed]).suspected).toBe(false);
  });
});

describe('a refused create carries no ref to match on', () => {
  const refusedCreate = call({
    arguments: JSON.stringify({ action: 'create', data: { title: 'Dark mode' } }),
    isError: true,
    resultPreview: 'the title is too thin',
  });

  it('reads a bare creation claim against whether anything was created', () => {
    const probe = detectStateConfab("I've filed it for you.", [refusedCreate]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.subject).toBeNull();
  });

  it('stays silent when another create in the same turn did land', () => {
    const landed = call({ arguments: JSON.stringify({ action: 'create', data: { title: 'y' } }) });
    expect(detectStateConfab("I've filed it for you.", [refusedCreate, landed]).suspected).toBe(
      false,
    );
  });

  // cm:guard this case asserted silence until 2026-09-14, on the reasoning that a named ref belongs to the ref arm — but a refused create targets no row, so the ref arm has nothing to match and the invented ref made BOTH arms quiet. Inventing a number is the worse confabulation, not the excused one.
  it('reports an invented ref when the create behind it was refused', () => {
    const probe = detectStateConfab('ISS-9 has been created.', [refusedCreate]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.subject).toBeNull();
    expect(probe.claims[0]?.sentence).toContain('ISS-9');
  });

  it('stays silent about an invented ref when a create did land', () => {
    const landed = call({ arguments: JSON.stringify({ action: 'create', data: { title: 'y' } }) });
    expect(detectStateConfab('ISS-9 has been created.', [refusedCreate, landed]).suspected).toBe(
      false,
    );
  });
});

describe('the probe never throws', () => {
  it('survives arguments that are not JSON', () => {
    const broken = call({ arguments: 'not json at all', isError: true });
    expect(() => detectStateConfab('ISS-2 has been set to open.', [broken])).not.toThrow();
    expect(detectStateConfab('ISS-2 has been set to open.', [broken]).suspected).toBe(false);
  });

  it('survives an empty reply and an empty turn', () => {
    expect(detectStateConfab('', [REFUSED_UPDATE]).suspected).toBe(false);
    expect(detectStateConfab('ISS-2 has been set to open.', []).suspected).toBe(false);
  });
});

describe('a denial is not a claim', () => {
  // cm:guard `successfully` and `done` are bare vocabulary in LANDED_RE, so without the negation read the probe reports an explicit denial — the one reply shape that proves the model got it right.
  it('says nothing when the reply states the write did NOT happen', () => {
    expect(
      detectStateConfab('ISS-2 was not updated successfully.', [REFUSED_UPDATE]).suspected,
    ).toBe(false);
  });

  it('still catches the affirmative that the denial is a negation of', () => {
    expect(detectStateConfab('ISS-2 was updated successfully.', [REFUSED_UPDATE]).suspected).toBe(
      true,
    );
  });

  it('reads the denial in the language that door answers in', () => {
    // cm:ignore CM001 — the directive below must sit on the literal's own line: `check-source-language.mjs` reads `i18n-allow` same-line only.
    const probe = detectStateConfab('ISS-2 không được chuyển sang open.', [REFUSED_UPDATE]); // i18n-allow: that door's own replies are written this way, so the probe is judged on one
    expect(probe.suspected).toBe(false);
  });
});

describe('a ref is read from what a call TARGETS', () => {
  // cm:guard both directions of this are invisible to a fixture that puts one ref in the arguments, which is what every case above does.
  it('does not let a ref quoted in a successful call answer for a refused one', () => {
    const landedElsewhere = call({
      arguments: JSON.stringify({
        action: 'update',
        documentId: 'ISS-1',
        data: { description: 'same root cause as ISS-2' },
      }),
    });
    const probe = detectStateConfab('ISS-2 has been updated.', [REFUSED_UPDATE, landedElsewhere]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.subject).toBe('ISS-2');
  });

  it('does not report a ref the refused call merely mentioned', () => {
    const refusedElsewhere = call({
      arguments: JSON.stringify({
        action: 'update',
        documentId: 'ISS-1',
        data: { description: 'blocked by ISS-2' },
      }),
      isError: true,
    });
    expect(detectStateConfab('ISS-2 has been updated.', [refusedElsewhere]).suspected).toBe(false);
  });
});

describe('a creation claim is what a refused create can contradict', () => {
  const refusedCreate = call({
    arguments: JSON.stringify({ action: 'create', data: { title: 'Dark mode' } }),
    isError: true,
  });
  const landedUpdate = call({
    arguments: JSON.stringify({
      action: 'update',
      documentId: 'ISS-1',
      data: { priority: 'high' },
    }),
  });

  // cm:guard suppressing the arm whenever the sentence named ANY landed ref hid the invented create behind the real one — criterion 2 protects ISS-1, not every other claim sharing its sentence.
  it('reports an invented create even when the sentence also names a ref that landed', () => {
    const probe = detectStateConfab('ISS-999 has been created alongside ISS-1.', [
      refusedCreate,
      landedUpdate,
    ]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.subject).toBeNull();
  });

  it('stays silent when the sentence claims an update, which no refused create contradicts', () => {
    expect(
      detectStateConfab('ISS-1 has been updated.', [refusedCreate, landedUpdate]).suspected,
    ).toBe(false);
  });

  // cm:guard the bare infinitive is the trap: a landed update whose text happens to contain "create" satisfied both matchers and reported a creation nobody claimed.
  it('does not read a bare infinitive in an update claim as a creation', () => {
    const probe = detectStateConfab(
      'ISS-1 has been updated to describe how to create a dashboard.',
      [refusedCreate, landedUpdate],
    );
    expect(probe.suspected).toBe(false);
  });

  // cm:guard the precedence rule had no case that could fail: a sentence answered by BOTH a targeted refusal and a refused create must report once, naming the row, never twice with a null subject beside it. Nothing but this asserts the `continue` that holds it.
  it('reports a sentence once when a targeted refusal and a refused create both answer it', () => {
    const probe = detectStateConfab('ISS-2 has been created.', [REFUSED_UPDATE, refusedCreate]);
    expect(probe.claims).toHaveLength(1);
    expect(probe.claims[0]?.subject).toBe('ISS-2');
  });

  it('names the first refused create in call order, whichever tool it came from', () => {
    const second = call({
      name: 'forge_comments',
      arguments: JSON.stringify({ action: 'create', data: { body: 'x' } }),
      isError: true,
    });
    const probe = detectStateConfab("I've filed it for you.", [refusedCreate, second]);
    expect(probe.claims).toHaveLength(1);
    expect(probe.claims[0]?.tool).toBe('forge_issues');
  });
});

describe('the denial list is bounded, and says so', () => {
  it('covers the `no way` construction a consult named', () => {
    expect(
      detectStateConfab('There is no way ISS-2 was updated successfully.', [REFUSED_UPDATE])
        .suspected,
    ).toBe(false);
  });
});

describe('the forge CLI is the tracker door, and its writes are read by verb', () => {
  const cli = (argv: string[], over: Partial<ToolCallRecord> = {}) =>
    call({ name: 'forge', arguments: JSON.stringify({ argv, body: '## Outcome' }), ...over });
  const refusedNew = cli(['new', '-', '--title', 'Dark mode', '--category', 'bug'], {
    isError: true,
    resultPreview: '{"exitCode":1,"stdout":"","stderr":"Hold — one issue per problem"}',
  });
  const refusedSet = cli(['issue', 'ISS-2', '--set', 'status=open', '--why', 'asked'], {
    isError: true,
  });

  // cm:guard this is the case the second reader named on 2026-09-15: with `forge` offered and the probe reading `action` alone, "ISS-999 has been created" over a refused `forge new` went unreported — the probe was blind to the one tracker door chat has (ISS-1009).
  it('reports an invented ref over a refused `forge new`', () => {
    const probe = detectStateConfab('ISS-999 has been created.', [refusedNew]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.tool).toBe('forge');
    expect(probe.claims[0]?.subject).toBeNull();
  });

  it('reports a status claim over a refused `forge issue --set`', () => {
    const probe = detectStateConfab('ISS-2 has been set to open.', [refusedSet]);
    expect(probe.suspected).toBe(true);
    expect(probe.claims[0]?.subject).toBe('ISS-2');
  });

  it('reports an update claim over a refused comment with a body', () => {
    const refused = cli(['comment', 'ISS-2', '-', '--title', 'Seen again'], { isError: true });
    expect(detectStateConfab('ISS-2 has been updated.', [refused]).suspected).toBe(true);
  });

  it('says nothing when the `forge new` landed', () => {
    const landed = cli(['new', '-', '--title', 'Dark mode', '--category', 'bug']);
    expect(detectStateConfab("I've filed it as ISS-7.", [landed]).suspected).toBe(false);
  });

  it('ignores a refused read, whatever ref it named', () => {
    const refusedRead = cli(['issue', 'ISS-2', '--full'], { isError: true });
    const refusedSearch = cli(['issue', '--search', 'ISS-2 dark mode'], { isError: true });
    const text = 'ISS-2 has been set to open.';
    expect(detectStateConfab(text, [refusedRead]).suspected).toBe(false);
    expect(detectStateConfab(text, [refusedSearch]).suspected).toBe(false);
  });

  it('ignores a refused thread read — `comment` with no body path', () => {
    const refused = cli(['comment', 'ISS-2'], { isError: true });
    expect(detectStateConfab('ISS-2 has been updated.', [refused]).suspected).toBe(false);
  });

  it('reads the target from the positional, not from a `--relates` ref beside it', () => {
    const refused = cli(['issue', 'ISS-1', '--relates', 'ISS-2'], { isError: true });
    expect(detectStateConfab('ISS-2 has been updated.', [refused]).suspected).toBe(false);
    expect(detectStateConfab('ISS-1 has been updated.', [refused]).suspected).toBe(true);
  });

  it('survives argv that is not an array', () => {
    const broken = call({ name: 'forge', arguments: '{"argv":"new"}', isError: true });
    expect(detectStateConfab('ISS-2 has been set to open.', [broken]).suspected).toBe(false);
  });
});
