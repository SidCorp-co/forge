import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockedBodySchema } from './blocked-wire.js';

const dialog = {
  kind: 'dialog',
  questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
};

describe('the blocked body', () => {
  it('takes the three things a pane can have stopped on', () => {
    for (const asked of [
      dialog,
      { kind: 'permission', tool: 'Bash', input: '{"command":"ls"}' },
      { kind: 'unread', why: 'no transcript path is known' },
    ]) {
      expect(blockedBodySchema.safeParse({ error: 'ended', asked }).success).toBe(true);
    }
  });

  it('refuses a body that names no pane question, naming the field', () => {
    const none = blockedBodySchema.safeParse({ error: 'ended' });
    expect(none.success).toBe(false);
    const empty = blockedBodySchema.safeParse({
      error: 'ended',
      asked: { kind: 'dialog', questions: [] },
    });
    expect(empty.success).toBe(false);
  });

  it('refuses a key it does not know, at either level', () => {
    expect(blockedBodySchema.safeParse({ error: 'e', asked: dialog, extra: 1 }).success).toBe(
      false,
    );
    const inner = { ...dialog, questions: [{ ...dialog.questions[0], mystery: true }] };
    expect(blockedBodySchema.safeParse({ error: 'e', asked: inner }).success).toBe(false);
  });

  it('refuses a kind that is not one of the three', () => {
    expect(
      blockedBodySchema.safeParse({ error: 'e', asked: { kind: 'shrug', why: 'x' } }).success,
    ).toBe(false);
  });
});

const RUNNER_SOURCE = fileURLToPath(
  new URL('../../../runner/crates/forge-runner-core/src/daemon/job_asked.rs', import.meta.url),
);

function runnerBound(name: string): number {
  const found = readFileSync(RUNNER_SOURCE, 'utf8').match(
    new RegExp(`const ${name}: usize = (\\d+);`),
  );
  if (!found) throw new Error(`job_asked.rs declares no ${name} on one line`);
  return Number(found[1]);
}

const accepted = (asked: unknown) => blockedBodySchema.safeParse({ error: 'e', asked }).success;
const withQuestion = (q: Record<string, unknown>) => ({
  kind: 'dialog',
  questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }], ...q }],
});

describe('the bounds the runner holds a report to', () => {
  const x = (n: number) => 'x'.repeat(n);
  const cases: Array<[string, (n: number) => unknown]> = [
    [
      'WIRE_QUESTIONS_MAX',
      (n) => ({ kind: 'dialog', questions: Array(n).fill(dialog.questions[0]) }),
    ],
    ['WIRE_QUESTION_MAX', (n) => withQuestion({ question: x(n) })],
    ['WIRE_HEADER_MAX', (n) => withQuestion({ header: x(n) })],
    ['WIRE_OPTIONS_MAX', (n) => withQuestion({ options: Array(n).fill({ label: 'Yes' }) })],
    ['WIRE_LABEL_MAX', (n) => withQuestion({ options: [{ label: x(n) }] })],
    [
      'WIRE_DESCRIPTION_MAX',
      (n) => withQuestion({ options: [{ label: 'Yes', description: x(n) }] }),
    ],
    ['WIRE_TOOL_MAX', (n) => ({ kind: 'permission', tool: x(n), input: '{}' })],
    ['WIRE_WHY_MAX', (n) => ({ kind: 'unread', why: x(n) })],
  ];

  it.each(cases)('%s is the last length core takes, and the next is refused', (name, build) => {
    const max = runnerBound(name);
    expect(accepted(build(max)), `${name} = ${max} is accepted`).toBe(true);
    expect(accepted(build(max + 1)), `${name} + 1 is refused`).toBe(false);
  });
});
