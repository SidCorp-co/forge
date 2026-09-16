/**
 * ISS-1066 — what reaches the judge: the rubric, the fixtures, the project brief and the earlier
 * turns. Split out of `run-capabilities.test.ts`, which was at the 500-line file budget.
 */

import { describe, expect, it } from 'vitest';
import { createClient } from './client.js';
import {
  createFakeDeployment,
  FAKE_PROJECT,
  FAKE_TOKEN,
  type FakeOptions,
  JUDGE_KEY,
  JUDGE_URL,
  type ScriptedTurn,
} from './fake-deployment.js';
import { BRIEF_HEADER, createJudge, isVerdict, REFERENCE_HEADER } from './judge.js';
import { runTrial, type TrialArgs } from './run.js';
import type { Task } from './task.js';
import { SHIPPED_TASKS } from './tasks/index.js';

const token = (m: string): string => /bench-[0-9a-f]{12}/.exec(m)?.[0] ?? '';
const say = (reply: string, toolCalls: ScriptedTurn['attempts'][number]['toolCalls'] = []) => ({
  attempts: [{ reply, toolCalls }],
});
const note = (m: string) => ({ name: 'forge_memory_note', arguments: JSON.stringify({ text: m }) });
const search = { name: 'forge_memory_search', arguments: '{}' };

let kept = '';
const recall: FakeOptions['script'] = (m) => {
  if (m.startsWith('Remember')) {
    kept = token(m);
    return { ...say('Kept.', [note(m)]), notes: [m] };
  }
  return say(`The release code name is ${kept}.`, [search]);
};

const task = (id: string): Task => {
  const t = SHIPPED_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};

function _trialOn(t: Task, over: Partial<FakeOptions> = {}, args: Partial<TrialArgs> = {}) {
  const fake = createFakeDeployment({ script: recall, ...over });
  const client = createClient({ api: 'https://api.test', fetch: fake.fetch });
  client.useToken(FAKE_TOKEN);
  return {
    fake,
    run: () => runTrial({ client, task: t, project: FAKE_PROJECT, runId: 'r1', ...args }),
  };
}

describe('what the judge is handed', () => {
  const verdict = JSON.stringify({ intent: 'i', served: 'yes', reason: 'r', quote: '' });

  it('the task rubric in the system prompt and the fixtures plus earlier turns as a reference block', async () => {
    const fake = createFakeDeployment({ script: recall, judge: () => verdict });
    const client = createClient({ api: 'https://api.test', fetch: fake.fetch });
    client.useToken(FAKE_TOKEN);
    const judge = createJudge({
      baseUrl: JUDGE_URL,
      apiKey: JUDGE_KEY,
      model: 'judge-model',
      fetch: fake.fetch,
      retryDelaysMs: [0],
    });
    const t = task('memory-store-recall');
    const ids = ['dddddddddddd', 'eeeeeeeeeeee'];
    const { result } = await runTrial({
      client,
      task: t,
      project: FAKE_PROJECT,
      runId: 'r1',
      judge,
      randomId: () => ids.shift() ?? '',
    });
    expect(result.error).toBeNull();
    expect(
      result.turns.map((x) => (x.judge && isVerdict(x.judge) ? x.judge.served : null)),
    ).toEqual(['yes', 'yes']);
    const [first, second] = fake.state.judgeCalls;
    expect(first?.system).toContain(`"served" is read by this rule as well: ${t.judgeRubric}`);
    expect(first?.user).toContain(
      `${REFERENCE_HEADER}\nnonce: bench-dddddddddddd\nnonce2: bench-eeeeeeeeeeee`,
    );
    expect(first?.user).not.toContain('turn 1 asked');
    expect(second?.user).toContain(
      'turn 1 asked: Remember for this project: the release code name is bench-dddddddddddd.',
    );
    expect(second?.user).toContain('turn 1 replied: Kept.');
  });

  // cm:why `preference-bullets` and not `filing-guidance`, which stood here: ISS-1066 gave that task a
  // rubric sending the judge to the brief's filing rules, so it is no longer a task without one. The
  // byte-identity of the block itself is pinned in judge.test.ts, over inputs a test controls exactly.
  it('a task without a rubric, fixtures or a brief sends the judge no rubric and no reference block', async () => {
    const fake = createFakeDeployment({ script: recall, judge: () => verdict });
    const client = createClient({ api: 'https://api.test', fetch: fake.fetch });
    client.useToken(FAKE_TOKEN);
    const judge = createJudge({
      baseUrl: JUDGE_URL,
      apiKey: JUDGE_KEY,
      model: 'judge-model',
      fetch: fake.fetch,
      retryDelaysMs: [0],
    });
    const bare = task('preference-bullets');
    expect(bare.judgeRubric).toBeUndefined();
    expect(bare.fixtures).toBeUndefined();
    await runTrial({ client, task: bare, project: FAKE_PROJECT, runId: 'r1', judge });
    const call = fake.state.judgeCalls[0];
    expect(call?.system).not.toContain('read by this rule as well');
    expect(call?.user).not.toContain(REFERENCE_HEADER);
  });

  it('the brief, where the run has one, under its own sub-header between the fixtures and the turns', async () => {
    const fake = createFakeDeployment({ script: recall, judge: () => verdict });
    const client = createClient({ api: 'https://api.test', fetch: fake.fetch });
    client.useToken(FAKE_TOKEN);
    const judge = createJudge({
      baseUrl: JUDGE_URL,
      apiKey: JUDGE_KEY,
      model: 'judge-model',
      fetch: fake.fetch,
      retryDelaysMs: [0],
    });
    const ids = ['dddddddddddd', 'eeeeeeeeeeee'];
    await runTrial({
      client,
      task: task('memory-store-recall'),
      project: FAKE_PROJECT,
      runId: 'r1',
      judge,
      brief: '# Some Project\nopen 682',
      randomId: () => ids.shift() ?? '',
    });
    const second = fake.state.judgeCalls[1]?.user ?? '';
    const fixtures = second.indexOf('nonce: bench-');
    const brief = second.indexOf(BRIEF_HEADER);
    const turns = second.indexOf('turn 1 asked:');
    expect(brief).toBeGreaterThan(fixtures);
    expect(turns).toBeGreaterThan(brief);
    expect(second).toContain(`${BRIEF_HEADER}\n# Some Project\nopen 682`);
  });
});
