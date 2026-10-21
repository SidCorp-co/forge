// REQ-47: forge_feedback takes where in Forge a report was met as ONE field, `target`, and judges a
// submit whole before anything is read or written; signalKeyOf names what a report is about, so two
// reporters wording one title alike join one item (BC-5).

import { describe, expect, it } from 'vitest';
import { signalKeyOf } from '../feedback/forge-intake.js';
import type { McpContext } from '../lib/tool.js';
import { forgeFeedbackTool, forgeSubmitRequestOf } from './tool.js';

describe('forge_feedback submit is judged whole', () => {
  it('stands a target for whereSeen, as kind then ref', () => {
    const judged = forgeSubmitRequestOf({
      kind: 'bug',
      title: 'claim refuses a free lease',
      target: { kind: 'command', ref: 'forge claim --next' },
      clientVersion: 'forge-plugin 3.36.542',
    });
    expect(judged).toEqual({
      ok: true,
      request: {
        kind: 'bug',
        title: 'claim refuses a free lease',
        whereSeen: 'command forge claim --next',
        clientVersion: 'forge-plugin 3.36.542',
      },
    });
  });

  it('refuses a submit with no target, naming /target and the shape it takes', () => {
    const judged = forgeSubmitRequestOf({ kind: 'bug', title: 'x' });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.refusals.map((r) => r.path)).toEqual(['/target']);
    expect(judged.refusals[0]?.detail).toMatch(/target: \{ kind: page \| command/);
  });

  it('names every field that cannot stand at once: an item key on submit and a missing title', () => {
    const judged = forgeSubmitRequestOf({
      feedback: 'FB-3',
      kind: 'bug',
      target: { kind: 'tool', ref: 'forge_issues' },
    });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.refusals.map((r) => r.path).sort()).toEqual(['/feedback', '/title']);
  });

  it('refuses a client version that is not one line', () => {
    const judged = forgeSubmitRequestOf({
      kind: 'idea',
      title: 'a',
      target: { kind: 'page', ref: '/issues' },
      clientVersion: 'web\n1.0',
    });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.refusals.map((r) => r.path)).toEqual(['/clientVersion']);
  });
});

describe('forge_feedback is not the project door (REQ-47 BC-7)', () => {
  // refused before the caller is read, so the context the call came in on is never touched
  const tool = forgeFeedbackTool({ projectSlug: null } as unknown as McpContext);
  const refusalsOf = (answer: unknown) =>
    (answer as { error: { refusals: { code: string; path: string; detail: string }[] } }).error
      .refusals;

  it('refuses projectId by name, pointing to project_feedback', async () => {
    const answer = await tool.handler({
      action: 'submit',
      projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
      kind: 'bug',
      title: 'x',
      target: { kind: 'tool', ref: 'forge_issues' },
    });
    expect(answer).toMatchObject({ _mcpIsError: true, status: 400 });
    const [refusal, ...rest] = refusalsOf(answer);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ code: 'FORGE_FEEDBACK_PROJECT_DOOR', path: '/projectId' });
    expect(refusal?.detail).toContain('project_feedback');
  });

  it('names a wrong argument with the shape it takes, beside the projectId refusal', async () => {
    const answer = await tool.handler({ action: 'get', feedback: 'ISS-7', projectId: 'p' });
    expect(refusalsOf(answer).map((r) => r.path)).toEqual(['/projectId', '/feedback']);
  });
});

describe('signalKeyOf', () => {
  it('keeps a key the reporter names', () => {
    expect(signalKeyOf({ kind: 'bug', title: 'anything', signalKey: 'cli:claim:lease' })).toBe(
      'cli:claim:lease',
    );
  });

  it('folds kind and title so two wordings alike name one key', () => {
    const a = signalKeyOf({ kind: 'bug', title: 'Claim  refuses a FREE lease!' });
    const b = signalKeyOf({ kind: 'bug', title: 'claim refuses a free lease' });
    expect(a).toBe('bug:claim refuses a free lease');
    expect(b).toBe(a);
  });

  it('keeps the kind apart: a bug and an idea of one title are two keys', () => {
    expect(signalKeyOf({ kind: 'idea', title: 'claim' })).not.toBe(
      signalKeyOf({ kind: 'bug', title: 'claim' }),
    );
  });
});
