/**
 * ISS-1051 — a whole trial over the scripted deployment: every shipped task passes alone on a
 * good script and fails on its own planted regression; a send that dies after a preference moved
 * still restores the baseline and deletes the room; a refused restore still deletes the room; and
 * the result file, read back, names the failing turn without the room that is gone.
 */

import { describe, expect, it } from 'vitest';
import { emptyFallbackReply } from '../../conversations/fallback-replies.js';
import { createClient } from './client.js';
import {
  createFakeDeployment,
  DEAD_ISSUE_ID,
  FAKE_ISSUE,
  FAKE_PROJECT,
  FAKE_TOKEN,
  FAKE_WAITING,
  type FakeOptions,
  type Script,
  type ScriptedAttempt,
  type ScriptedTurn,
} from './fake-deployment.js';
import { type BenchResult, readResult, serializeResult } from './result.js';
import { runTrial } from './run.js';
import type { Task } from './task.js';
import { SHIPPED_TASKS } from './tasks/index.js';

const LINK = `/projects/qa/issues/${FAKE_ISSUE.id}`;
const forge = (...argv: string[]) => ({ name: 'forge', arguments: JSON.stringify({ argv }) });
const say = (reply: string, toolCalls: ScriptedAttempt['toolCalls'] = []): ScriptedTurn => ({
  attempts: [{ reply, toolCalls }],
});

const token = (m: string): string => /bench-[0-9a-f]{12}/.exec(m)?.[0] ?? '';
const memoryNote = (text: string) => ({
  name: 'forge_memory_note',
  arguments: JSON.stringify({ text }),
});
const memorySearch = { name: 'forge_memory_search', arguments: '{"query":"release code name"}' };
/** The tokens the current trial asked the assistant to keep, first to last. */
let kept: string[] = [];

/** The memory tasks' turns are told apart by their text: a new room starts its turn count over. */
function memoryTurn(m: string, recallWith: string | null, search: boolean): ScriptedTurn {
  if (m.startsWith('Remember')) {
    kept = [token(m)];
    return { ...say('Kept: the release code name.', [memoryNote(m)]), notes: [m] };
  }
  if (m.startsWith('Correction')) {
    kept.push(token(m));
    return { ...say('Updated: the release code name.', [memoryNote(m)]), notes: [m] };
  }
  return say(
    `The release code name is ${recallWith ?? kept.at(-1)}.`,
    search ? [memorySearch] : [],
  );
}

const WAITING_LINK = `/projects/qa/issues/${FAKE_WAITING.id}`;
const THREAD_LAST = 9;

const good: Script = (m, taskId, turn) => {
  switch (taskId) {
    case 'project-issue-counts':
      return say('Open: 1, closed: 1, draft: 0.', [
        forge('issue', '--status', 'open'),
        forge('issue', '--status', 'closed'),
        forge('issue', '--status', 'draft'),
      ]);
    case 'project-pipeline-states':
      return say('open → in_progress → awaiting_release');
    case 'project-waiting-issue':
      return say(`ISS-9 Needs a repro is waiting on information.\n\n${WAITING_LINK}`, [
        forge('issue', '--status', 'needs_info'),
      ]);
    case 'memory-store-recall':
    case 'memory-correction':
      return memoryTurn(m, null, true);
    case 'long-context-needle':
      return say('Thursday.');
    case 'long-context-thread':
      if (turn < 8) return say('Noted.');
      if (turn === 8) return say('3 open issues.', [forge('issue', '--status', 'open')]);
      return say('Priya Raman reviews the release, and we deploy on Wednesday.');
    case 'memory-question':
      return turn === 0
        ? say('Noted: Thursday 14:00 UTC.')
        : say('Your deploy window is Thursday 14:00 UTC.');
    case 'memory-followup':
      return turn === 0
        ? say('This room is scoped to QA Project.')
        : say('It has 3 open issues.', [forge('issue', '--status', 'open')]);
    case 'open-issues-linked':
      return say(`- ISS-7 Widget wobbles ${LINK}`, [
        forge('issue', '--status', 'open'),
        forge('issue', 'ISS-7'),
      ]);
    case 'one-issue-by-key':
      return say(`ISS-7 is about a wobbling widget.\n\n${LINK}`, [forge('issue', 'ISS-7')]);
    case 'preference-bullets':
      return {
        ...say('Done: bullet points from now on.', [
          { name: 'forge_preferences', arguments: '{"answerStyle":"bullets"}' },
        ]),
        moves: [{ answerStyle: 'bullets' }],
      };
    case 'summary-in-style':
      return say('- A QA project\n- Used for testing the assistant');
    case 'out-of-reach-tests':
      return say('I cannot run the test suite from here; CI runs it on every push.');
    case 'vietnamese-count':
      // cm:ignore CM001 — the scripted Vietnamese answer the vietnamese-count task expects
      return say('Dự án hiện có 3 issue đang mở.', [forge('issue', '--status', 'open')]); // i18n-allow: test fixture
    case 'filing-guidance':
      return say('Run forge new with a title and a description; the CLI echoes the documentId.');
    case 'preference-restore':
      return turn === 0
        ? { ...say('Concise from now on.'), moves: [{ answerStyle: 'concise' }] }
        : { ...say('Restored your previous style.'), moves: [{ answerStyle: 'default' }] };
    default:
      throw new Error(`no script for ${taskId}`);
  }
};

/** One planted regression per shipped task, and the mode it must be named by. */
const planted: Record<string, { script: Script; mode: string }> = {
  'memory-question': {
    mode: 'unanswered',
    script: (m, t, i) => (i === 0 ? good(m, t, i) : say("I don't have that information.")),
  },
  'memory-followup': {
    mode: 'placeholder_argument',
    script: (m, t, i) =>
      i === 0 ? good(m, t, i) : say('It has 3 open issues.', [forge('issue', 'ISS-<n>')]),
  },
  'open-issues-linked': {
    mode: 'unanswered',
    script: () => say('- ISS-7 Widget wobbles', [forge('issue', '--status', 'open')]),
  },
  'one-issue-by-key': {
    mode: 'dead_link',
    script: () =>
      say(`Wobbling widget. ${LINK} (see also /projects/qa/issues/${DEAD_ISSUE_ID})`, [
        forge('issue', 'ISS-7'),
      ]),
  },
  'preference-bullets': {
    mode: 'preference_not_moved',
    script: () => say('Sure, bullets from now on.'),
  },
  'summary-in-style': {
    mode: 'unanswered',
    script: () => say('This project is a QA sandbox used for testing.'),
  },
  'out-of-reach-tests': { mode: 'unanswered', script: () => say('All tests passed.') },
  'vietnamese-count': {
    mode: 'language_mismatch',
    script: () => say('The project has 3 open issues.', [forge('issue', '--status', 'open')]),
  },
  'filing-guidance': {
    mode: 'forbidden_tool',
    script: () => say('Filed it for you with forge new.', [forge('new', '-', '--title', 'Bug')]),
  },
  'preference-restore': {
    mode: 'preference_not_moved',
    script: (m, t, i) => (i === 0 ? good(m, t, i) : say('Undone.')),
  },
  'project-issue-counts': {
    mode: 'missing_tool',
    script: () => say('Open: 1, closed: 1, draft: 0.'),
  },
  'project-pipeline-states': {
    mode: 'unanswered',
    script: () => say('awaiting_release → in_progress → open'),
  },
  'project-waiting-issue': {
    mode: 'unanswered',
    script: () => say(`ISS-7 is waiting.\n\n${LINK}`, [forge('issue', '--status', 'needs_info')]),
  },
  'memory-store-recall': { mode: 'missing_tool', script: (m) => memoryTurn(m, null, false) },
  'memory-correction': {
    mode: 'unanswered',
    script: (m) => memoryTurn(m, m.startsWith('What') ? (kept[0] ?? '') : null, true),
  },
  'long-context-needle': { mode: 'unanswered', script: () => say('Friday.') },
  'long-context-thread': {
    mode: 'unanswered',
    script: (m, t, i) =>
      i === THREAD_LAST
        ? say('Which reviewer do you mean? Remind me of the deploy day.')
        : good(m, t, i),
  },
};

const task = (id: string): Task => {
  const found = SHIPPED_TASKS.find((t) => t.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

function trialOn(t: Task, over: Partial<FakeOptions> = {}, opts: { retryDelayMs?: number } = {}) {
  const fake = createFakeDeployment({ script: good, ...over });
  const client = createClient({ api: 'https://api.test', fetch: fake.fetch, ...opts });
  client.useToken(FAKE_TOKEN);
  return { fake, run: () => runTrial({ client, task: t, project: FAKE_PROJECT, runId: 'r1' }) };
}

describe('every shipped task alone', () => {
  for (const t of SHIPPED_TASKS) {
    it(`${t.id} passes on the good script and leaves the deployment as found`, async () => {
      const { fake, run } = trialOn(t);
      const { result, model } = await run();
      expect(result.error).toBeNull();
      expect(
        result.turns.map((x) => x.modes),
        t.id,
      ).toEqual(t.turns.map(() => []));
      expect(result.pass).toBe(true);
      expect(model).toBe('fake-model');
      expect(result.cleanup.rooms.map((r) => r.observed)).toEqual(
        result.cleanup.rooms.map(() => '404'),
      );
      expect(fake.state.rooms.size).toBe(0);
      expect(fake.state.notes, 'notes left behind').toEqual([]);
      expect(fake.state.prefs).toEqual({ answerStyle: 'default', assistantInstructions: null });
      if (t.preference) expect(result.cleanup.preferences.equal).toBe(true);
      else
        expect(result.cleanup.preferences).toEqual({
          expected: null,
          observed: null,
          equal: null,
          at: null,
        });
    });

    it(`${t.id} fails its planted regression as ${planted[t.id]?.mode}`, async () => {
      const plant = planted[t.id];
      if (!plant) throw new Error(`no planted regression for ${t.id}`);
      const { run } = trialOn(t, { script: plant.script });
      const { result } = await run();
      expect(result.pass).toBe(false);
      expect(result.turns.flatMap((x) => x.modes)).toContain(plant.mode);
      expect(result.cleanup.rooms[0]?.observed).toBe('404');
    });
  }
});

describe('what a trial records', () => {
  it('titles the room after the run and the task, and reads the trail once per send', async () => {
    const { fake, run } = trialOn(task('memory-question'));
    await run();
    const opened = fake.state.requests.find(
      (r) => r.method === 'POST' && r.path === '/api/conversations',
    );
    expect(opened).toBeDefined();
    expect(fake.state.chatLogs.map((r) => r.sessionId)).toEqual(['room-0001', 'room-0001']);
    expect(fake.state.requests.filter((r) => r.path === '/api/chat-logs')).toHaveLength(2);
  });

  it('keeps a screen repair as two attempts and names it', async () => {
    const script: Script = () => ({
      attempts: [
        { reply: 'ISS-7 Widget wobbles', toolCalls: [forge('issue', '--status', 'open')] },
        { reply: `- ISS-7 ${LINK}`, toolCalls: [] },
      ],
    });
    const { result } = await trialOn(task('open-issues-linked'), { script }).run();
    expect(result.turns[0]?.modes).toEqual(['screen_repair']);
    expect(result.turns[0]?.attempts.map((a) => a.reply)).toEqual([
      'ISS-7 Widget wobbles',
      `- ISS-7 ${LINK}`,
    ]);
  });

  it('grades a delivered fallback from the delivered text while keeping the empty raw attempt', async () => {
    const script: Script = () => ({
      attempts: [{ reply: null, error: 'empty-reply' }],
      deliver: emptyFallbackReply('Forge'),
    });
    const { result } = await trialOn(task('filing-guidance'), { script }).run();
    expect(result.turns[0]?.modes).toContain('fallback_sent');
    expect(result.turns[0]?.attempts).toEqual([
      expect.objectContaining({ reply: null, error: 'empty-reply' }),
    ]);
  });

  it('a send that dies after a preference moved still restores the baseline and deletes the room', async () => {
    const script: Script = () => ({
      attempts: [{ reply: 'x' }],
      moves: [{ answerStyle: 'bullets' }],
      failWith: 500,
    });
    const { fake, run } = trialOn(task('preference-bullets'), { script });
    const { result } = await run();
    expect(result.pass).toBe(false);
    expect(result.error).toContain('answered 500');
    expect(result.cleanup.rooms[0]?.observed).toBe('404');
    expect(result.cleanup.preferences).toMatchObject({
      expected: { answerStyle: 'default', assistantInstructions: null },
      equal: true,
    });
    expect(fake.state.prefs.answerStyle).toBe('default');
    expect(result.cleanup.auditRowsAdded).toBe(2);
  });

  it('a refused restore still deletes the room and the result says what was left', async () => {
    let patches = 0;
    const refuse: FakeOptions['refuse'] = (method, path) =>
      method === 'PATCH' && path === '/api/auth/preferences' && ++patches === 2 ? 503 : null;
    const { fake, run } = trialOn(task('summary-in-style'), { refuse });
    const { result } = await run();
    expect(result.turns[0]?.pass).toBe(true);
    expect(result.cleanup.rooms[0]?.observed).toBe('404');
    expect(result.cleanup.preferences).toMatchObject({
      expected: { answerStyle: 'default' },
      observed: null,
      equal: false,
    });
    expect(fake.state.prefs.answerStyle).toBe('bullets');
  });

  it('a refused room deletion is written as refused, and the trial is not a pass (ISS-1061)', async () => {
    const refuse: FakeOptions['refuse'] = (method) => (method === 'DELETE' ? 500 : null);
    const { result } = await trialOn(task('filing-guidance'), { refuse }).run();
    expect(result.cleanup.rooms[0]?.observed).toMatch(
      /^refused: DELETE \/api\/conversations\/room-0001 answered 500/,
    );
    expect(result.turns.every((t) => t.pass)).toBe(true);
    expect(result.pass).toBe(false);
  });

  it('a GET that throws once and answers on the retry is not an error, and the trial counts the retry (ISS-1065)', async () => {
    let trailReads = 0;
    const throwOn: FakeOptions['throwOn'] = (method, path) => {
      if (method !== 'GET' || !path.startsWith('/api/chat-logs')) return null;
      trailReads += 1;
      return trailReads === 1
        ? Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
        : null;
    };
    const { result } = await trialOn(
      task('filing-guidance'),
      { throwOn },
      { retryDelayMs: 1 },
    ).run();
    expect(result.error).toBeNull();
    expect(result.pass).toBe(true);
    expect(result.retried).toBe(1);
  });

  it('a GET that throws on both attempts ends the trial with an error naming the request and the cause, still deleting the room', async () => {
    const throwOn: FakeOptions['throwOn'] = (method, path) =>
      method === 'GET' && path.startsWith('/api/chat-logs')
        ? Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
        : null;
    const { result } = await trialOn(
      task('filing-guidance'),
      { throwOn },
      { retryDelayMs: 1 },
    ).run();
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/^fetch failed \(cause: ECONNRESET\) on GET \/api\/chat-logs/);
    expect(result.error).toContain(
      'first attempt: fetch failed (cause: ECONNRESET) on GET /api/chat-logs',
    );
    expect(result.retried).toBe(1);
    expect(result.cleanup.rooms[0]?.observed).toBe('404');
  });

  it('a non-default baseline comes back equal', async () => {
    const prefs = { answerStyle: 'concise', assistantInstructions: 'Always cite the issue key.' };
    // cm:why 2 rows for summary-in-style (setup, restore) and 4 for preference-restore (setup, the move, the undo, restore): every real move is one row through the one writer
    for (const [id, rows] of [
      ['summary-in-style', 2],
      ['preference-restore', 4],
    ] as const) {
      const { fake, run } = trialOn(task(id), { prefs });
      const { result } = await run();
      expect(result.pass, id).toBe(true);
      expect(result.cleanup.preferences, id).toMatchObject({
        expected: prefs,
        observed: prefs,
        equal: true,
      });
      expect(fake.state.prefs, id).toEqual(prefs);
      expect(result.cleanup.auditRowsAdded, id).toBe(rows);
    }
  });
});

describe('the result file', () => {
  it('serialized and read back names the failing turn and the cleanup without any request', async () => {
    const plant = planted['memory-question'];
    if (!plant) throw new Error('no plant');
    const { result } = await trialOn(task('memory-question'), { script: plant.script }).run();
    const file: BenchResult = {
      at: 'now',
      api: 'https://api.test',
      commit: 'abc',
      version: '0.3.0',
      model: 'fake-model',
      runId: 'r1',
      k: 3,
      tasks: [{ id: 'memory-question', capability: 'method', trials: [result] }],
    };
    const back = readResult(serializeResult(file));
    const trial = back.tasks[0]?.trials[0];
    expect(trial?.turns.map((t) => t.pass)).toEqual([true, false]);
    expect(trial?.turns[1]?.evidence).toEqual([
      { mode: 'unanswered', fact: 'reply does not match /thursday/i' },
      { mode: 'unanswered', fact: 'reply does not match /14:00/' },
    ]);
    expect(trial?.turns[1]?.reply).toBe("I don't have that information.");
    expect(trial?.cleanup.rooms[0]).toMatchObject({
      id: 'room-0001',
      expected: 'deleted',
      observed: '404',
    });
  });

  it('reads a trial written before the retry existed as retried 0 (ISS-1065)', async () => {
    const { result } = await trialOn(task('filing-guidance')).run();
    const file = JSON.parse(
      serializeResult({
        at: 'x',
        api: 'https://api.test',
        commit: null,
        version: '0.3.0',
        model: 'm',
        runId: 'r',
        k: 1,
        tasks: [{ id: 'filing-guidance', capability: 'method', trials: [result] }],
      }),
    ) as { tasks: Array<{ trials: Array<Record<string, unknown>> }> };
    delete file.tasks[0]?.trials[0]?.retried;
    expect(readResult(JSON.stringify(file)).tasks[0]?.trials[0]?.retried).toBe(0);
  });

  it('refuses a file missing a key, by name', () => {
    expect(() => readResult('{"at":"x"}')).toThrow('result lacks api');
    expect(() => readResult('[]')).toThrow('result is not an object');
    const noCleanup = {
      at: 1,
      api: 1,
      commit: 1,
      version: 1,
      model: 1,
      runId: 1,
      k: 3,
      tasks: [
        {
          id: 'a',
          capability: 'method',
          trials: [{ at: 1, pass: true, error: null, seconds: 1, turns: [] }],
        },
      ],
    };
    expect(() => readResult(JSON.stringify(noCleanup), 'before.json')).toThrow(
      'before.json.tasks[0].trials[0] lacks cleanup',
    );
  });
});
