/**
 * ISS-1061 — what a trial does for the capability tasks: the fixtures it reads, the second room a
 * `room: 'new'` turn opens and the pairing of each room's trail, the notes it removes with a
 * read-back, and the rubric and reference block the judge is handed.
 */

import { describe, expect, it } from 'vitest';
import { createClient } from './client.js';
import { capabilitiesOf } from './compare.js';
import {
  createFakeDeployment,
  FAKE_ISSUE,
  FAKE_PROJECT,
  FAKE_TOKEN,
  FAKE_WAITING,
  type FakeOptions,
  type ScriptedTurn,
} from './fake-deployment.js';
import { readResult } from './result.js';
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

function trialOn(t: Task, over: Partial<FakeOptions> = {}, args: Partial<TrialArgs> = {}) {
  const fake = createFakeDeployment({ script: recall, ...over });
  const client = createClient({ api: 'https://api.test', fetch: fake.fetch });
  client.useToken(FAKE_TOKEN);
  return {
    fake,
    run: () => runTrial({ client, task: t, project: FAKE_PROJECT, runId: 'r1', ...args }),
  };
}

describe('fixtures', () => {
  it('nonce and nonce2 are fresh, distinct, and carried into the message', async () => {
    const ids = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
    const { fake, run } = trialOn(
      task('memory-store-recall'),
      {},
      { randomId: () => ids.shift() ?? '' },
    );
    const { result } = await run();
    expect(result.turns[0]?.message).toBe(
      'Remember for this project: the release code name is bench-aaaaaaaaaaaa.',
    );
    expect(result.pass).toBe(true);
    expect(fake.state.notes).toEqual([]);
  });

  it('two tokens that come out equal are refused rather than graded', async () => {
    const { run } = trialOn(task('memory-correction'), {}, { randomId: () => 'cccccccccccc' });
    const { result } = await run();
    expect(result.error).toBe('nonce and nonce2 came out equal');
    expect(result.pass).toBe(false);
  });

  it('issue counts walk every page and count by status; the waiting issue is its own fixture', async () => {
    const { fake, run } = trialOn(task('project-issue-counts'), {
      pageSize: 1,
      script: () =>
        say('Open: 1, closed: 1, draft: 0.', [{ name: 'forge', arguments: '{"argv":["issue"]}' }]),
    });
    const { result } = await run();
    expect(result.error).toBeNull();
    const pages = fake.state.requests.filter(
      (r) => r.path === `/api/projects/${FAKE_PROJECT.id}/issues`,
    );
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const { run: waiting } = trialOn(task('project-waiting-issue'), {
      issues: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          displayId: 'ISS-7',
          title: 't',
          status: 'open',
        },
      ],
    });
    const w = await waiting();
    expect(w.result.error).toContain('the project holds no issue waiting on information');
    const { run: counts } = trialOn(task('project-issue-counts'), {
      issues: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          displayId: 'ISS-7',
          title: 't',
          status: 'open',
        },
      ],
      script: () =>
        say('Open: 1, closed: 0, draft: 0.', [{ name: 'forge', arguments: '{"argv":["issue"]}' }]),
    });
    expect((await counts()).result.pass).toBe(true);
  });

  it('pipeline states fill the joined list from the effective ladder, in order, with nothing outside it', async () => {
    const LADDER = [
      'open',
      'confirmed',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'awaiting_release',
      'closed',
    ];
    const on = (reply: string, over: { states?: string[]; statesOff?: string[] } = {}) =>
      trialOn(task('project-pipeline-states'), {
        states: ['open'],
        ...over,
        script: () => say(reply),
      }).run();

    expect((await on(LADDER.join(', '))).result.pass).toBe(true);

    // The one-key config that started this: the stored map names `open` alone and the answer is still the whole sequence.
    const oneKey = await on('open');
    expect(oneKey.result.pass).toBe(false);
    expect(oneKey.result.turns[0]?.evidence.map((e) => e.fact)).toEqual(
      LADDER.slice(1).map((s) => `reply does not match ${s}`),
    );

    const late = await on(
      'open, confirmed, approved, in_progress, developed, awaiting_release, testing, closed',
    );
    expect(late.result.turns[0]?.evidence.map((e) => e.fact)).toEqual([
      'reply names awaiting_release before testing',
    ]);

    const outside = await on(`${LADDER.join(', ')}, dropped`);
    expect(outside.result.pass).toBe(false);
    expect(outside.result.turns[0]?.evidence.map((e) => e.fact)).toEqual([
      `reply names state dropped outside ${LADDER.join(', ')}`,
    ]);

    // A stage the project switched off leaves the ladder, and naming it is then naming a state outside the list.
    const withoutRelease = LADDER.filter((s) => s !== 'awaiting_release');
    const off = await on(withoutRelease.join(', '), { statesOff: ['awaiting_release'] });
    expect(off.result.pass).toBe(true);
    const named = await on(LADDER.join(', '), { statesOff: ['awaiting_release'] });
    expect(named.result.pass).toBe(false);

    // An empty stored config is every rung, never none: the refusal that stood here was a WRONG refusal.
    const { run: empty } = trialOn(task('project-pipeline-states'), {
      states: [],
      script: () => say(LADDER.join(', ')),
    });
    const none = await empty();
    expect(none.result.error).toBeNull();
    expect(none.result.pass).toBe(true);
  });
});

describe('what a thread may keep (ISS-1064)', () => {
  const thread = task('long-context-thread');
  const last = thread.turns.length - 1;
  const script =
    (notesOn: (turn: number) => boolean): FakeOptions['script'] =>
    (m, _task, turn) => {
      if (turn === last) return say('Priya Raman reviews the release, and we deploy on Wednesday.');
      if (turn === last - 1)
        return say('3 open issues.', [
          { name: 'forge', arguments: '{"argv":["issue","--status","open"]}' },
        ]);
      return notesOn(turn) ? { ...say('Noted.', [note(m)]), notes: [m] } : say('Noted.');
    };

  it('a note per stated fact fails the last turn as repeated_call, naming the counts; two notes pass; a refused listing fails naming it', async () => {
    const every = await trialOn(thread, { script: script(() => true) }).run();
    expect(every.result.cleanup.memories?.found).toBe(8);
    expect(every.result.pass).toBe(false);
    const lastTurn = every.result.turns[last];
    expect(lastTurn?.modes).toEqual(['repeated_call']);
    expect(lastTurn?.evidence.map((e) => e.fact)).toEqual(['kept 8 note(s), at most 2 allowed']);
    expect(every.result.turns.slice(0, last).every((t) => t.pass)).toBe(true);

    const two = await trialOn(thread, { script: script((turn) => turn === 0 || turn === 3) }).run();
    expect(two.result.cleanup.memories?.found).toBe(2);
    expect(two.result.pass).toBe(true);

    const refuse: FakeOptions['refuse'] = (method, path) =>
      method === 'GET' && path === '/api/memory' ? 500 : null;
    const unknown = await trialOn(thread, { script: script(() => false), refuse }).run();
    expect(unknown.result.turns[last]?.evidence.map((e) => e.fact)).toEqual([
      'notes kept unknown: the memory listing was refused',
    ]);
    expect(unknown.result.pass).toBe(false);
  });
});

describe('what a project-understanding grade holds (codex F1–F3)', () => {
  it('issue counts must stand beside their status: a swap or an inflated figure fails', async () => {
    const forge = [{ name: 'forge', arguments: '{"argv":["issue"]}' }];
    const on = (reply: string) =>
      trialOn(task('project-issue-counts'), { script: () => say(reply, forge) }).run();
    expect((await on('Open: 1, closed: 1, draft: 0.')).result.pass).toBe(true);
    expect(
      (await on('| status | count |\n| open | 1 |\n| closed | 1 |\n| drafts | 0 |')).result.pass,
    ).toBe(true);
    expect((await on('There is 1 open issue, 1 closed issue and 0 drafts.')).result.pass).toBe(
      true,
    );
    expect((await on('1 open / 1 closed / 0 drafts')).result.pass).toBe(true);
    expect((await on('| 1 | open |\n| 1 | closed |\n| 0 | drafts |')).result.pass).toBe(true);
    const inflated = await on('Open: 10, closed: 10, drafts: 10.');
    expect(inflated.result.turns[0]?.evidence.map((e) => e.fact)).toEqual([
      'reply does not pair /open/i with 1',
      'reply does not pair /closed/i with 1',
      'reply does not pair /drafts?/i with 0',
    ]);
    const borrowed = await on('Open: 1 and closed: 0 and drafts: 1.');
    expect(borrowed.result.turns[0]?.evidence.map((e) => e.fact)).toEqual([
      'reply does not pair /closed/i with 1',
      'reply does not pair /drafts?/i with 0',
    ]);
    const swapped = await on('Open: 0, closed: 1, drafts: 1.');
    expect(swapped.result.turns[0]?.evidence.map((e) => e.fact)).toEqual([
      'reply does not pair /open/i with 1',
      'reply does not pair /drafts?/i with 0',
    ]);
  });

  it('the waiting issue must be linked itself: no link, or a link to another live issue, fails', async () => {
    const forge = [{ name: 'forge', arguments: '{"argv":["issue","--status","needs_info"]}' }];
    const on = (reply: string) =>
      trialOn(task('project-waiting-issue'), { script: () => say(reply, forge) }).run();
    const other = `/projects/qa/issues/${FAKE_ISSUE.id}`;
    expect(
      (await on(`ISS-9 is waiting.\n\n/projects/qa/issues/${FAKE_WAITING.id}`)).result.pass,
    ).toBe(true);
    expect((await on('ISS-9 is waiting on information.')).result.turns[0]?.evidence).toEqual([
      { mode: 'unanswered', fact: `no link to issue ${FAKE_WAITING.id}` },
    ]);
    expect((await on(`ISS-9 is waiting.\n\n${other}`)).result.turns[0]?.modes).toEqual([
      'unanswered',
    ]);
  });
});

describe('a turn in a new room', () => {
  it('opens a second room, pairs each room on its own trail, and deletes both with a read-back', async () => {
    const { fake, run } = trialOn(task('memory-store-recall'));
    const { result } = await run();
    expect(result.pass).toBe(true);
    expect(fake.state.chatLogs.map((r) => r.sessionId)).toEqual(
      result.cleanup.rooms.map((r) => r.id),
    );
    expect(result.turns.map((t) => t.attempts.length)).toEqual([1, 1]);
    expect(result.turns[1]?.attempts[0]?.chatLogId).toBe(fake.state.chatLogs[1]?.id);
    expect(result.cleanup.rooms.map((r) => r.observed)).toEqual(['404', '404']);
    expect(new Set(result.cleanup.rooms.map((r) => r.id)).size).toBe(2);
    expect(fake.state.deleted).toEqual(result.cleanup.rooms.map((r) => r.id));
    const titles = fake.state.requests.filter(
      (r) => r.method === 'POST' && r.path === '/api/conversations',
    );
    expect(titles).toHaveLength(2);
  });

  it('a second room the deployment will not delete fails the trial by name', async () => {
    let deletes = 0;
    const { run } = trialOn(task('memory-store-recall'), {
      refuse: (method, path) =>
        method === 'DELETE' && path.startsWith('/api/conversations/') && ++deletes === 2
          ? 500
          : null,
    });
    const { result } = await run();
    expect(result.turns.every((t) => t.pass)).toBe(true);
    expect(result.cleanup.rooms[1]?.observed).toMatch(/^refused: DELETE/);
    expect(result.pass).toBe(false);
  });
});

describe('memory cleanup', () => {
  const seeded = [
    { id: 'n1', sourceRef: 'ref-old-1', textContent: 'an older note', archivedAt: null },
    {
      id: 'n2',
      sourceRef: 'ref-old-2',
      textContent: 'an archived note',
      archivedAt: '2026-09-01T00:00:00.000Z',
    },
  ];

  it('finds the notes carrying either token across every page, archived included, deletes them and reads back none', async () => {
    const { fake, run } = trialOn(task('memory-correction'), {
      pageSize: 1,
      notes: seeded,
      script: (m) => {
        if (m.startsWith('What')) return say(`The release code name is ${kept}.`, [search]);
        kept = token(m);
        return { ...say('Kept.', [note(m)]), notes: [m, `archived copy ${token(m)}`] };
      },
    });
    const { result } = await run();
    expect(result.cleanup.memories).toEqual({ found: 4, deleted: 4, remaining: 0 });
    expect(fake.state.notes).toEqual(seeded);
    const lists = fake.state.requests.filter((r) => r.method === 'GET' && r.path === '/api/memory');
    expect(lists.length).toBeGreaterThanOrEqual(8);
    expect(result.pass).toBe(true);
  });

  it('a note the deployment will not delete is counted remaining and fails the trial', async () => {
    const { fake, run } = trialOn(task('memory-store-recall'), {
      refuse: (method, path) =>
        method === 'DELETE' && path === '/api/memory/by-source' ? 503 : null,
    });
    const { result } = await run();
    expect(result.cleanup.memories).toEqual({ found: 1, deleted: 0, remaining: 1 });
    expect(fake.state.notes).toHaveLength(1);
    expect(result.turns.every((t) => t.pass)).toBe(true);
    expect(result.pass).toBe(false);
  });

  it('a method task that kept a note without any token has it removed too; a note held before the trial and one somebody else writes meanwhile both stay (codex F1)', async () => {
    const { fake, run } = trialOn(task('memory-question'), {
      notes: seeded,
      script: (m) =>
        m.startsWith('Please remember')
          ? {
              ...say('Noted: Thursday 14:00 UTC.', [note(m)]),
              notes: ['Deploy window: Thursday 14:00 UTC'],
              foreignNotes: ['A colleague notes the deploy window is Thursday too'],
            }
          : say('Your deploy window is Thursday 14:00 UTC.'),
    });
    const { result } = await run();
    expect(result.cleanup.memories).toEqual({ found: 1, deleted: 1, remaining: 0 });
    expect(fake.state.notes.map((n) => n.textContent)).toEqual([
      ...seeded.map((n) => n.textContent),
      'A colleague notes the deploy window is Thursday too',
    ]);
    expect(result.pass).toBe(true);
  });

  it('a listing the deployment refuses is counted as one remaining, and a trial that opened no room records null', async () => {
    const { run } = trialOn(task('filing-guidance'), {
      script: () =>
        say('Run forge new with a title and a description; the CLI echoes the documentId.'),
      refuse: (method, path) => (method === 'GET' && path === '/api/memory' ? 503 : null),
    });
    const { result } = await run();
    expect(result.error).toBeNull();
    expect(result.cleanup.memories).toEqual({ found: 0, deleted: 0, remaining: 1 });
    expect(result.pass).toBe(false);
    const { run: noRoom } = trialOn(task('project-waiting-issue'), { issues: [FAKE_ISSUE] });
    const r = await noRoom();
    expect(r.result.cleanup.rooms).toEqual([]);
    expect(r.result.cleanup.memories).toBeNull();
  });
});

describe('a run file written before ISS-1061', () => {
  it('reads with every task as method, one room per trial and no memory record', () => {
    const old = {
      at: 'x',
      api: 'a',
      commit: 'c',
      version: 'v',
      model: 'm',
      runId: 'r',
      k: 3,
      tasks: [
        {
          id: 'memory-question',
          trials: [
            {
              at: 'x',
              pass: true,
              error: null,
              seconds: 1,
              turns: [],
              cleanup: {
                room: { id: 'room-1', expected: 'deleted', observed: '404', at: 'x' },
                preferences: { expected: null, observed: null, equal: null, at: null },
                auditRowsAdded: 0,
              },
            },
          ],
        },
      ],
    };
    const back = readResult(JSON.stringify(old), 'old.json');
    expect(back.tasks[0]?.capability).toBe('method');
    expect(back.tasks[0]?.trials[0]?.cleanup).toEqual({
      rooms: [{ id: 'room-1', expected: 'deleted', observed: '404', at: 'x' }],
      preferences: { expected: null, observed: null, equal: null, at: null },
      auditRowsAdded: 0,
      memories: null,
    });
    expect(back.capabilities).toBeUndefined();
    expect(capabilitiesOf(back, 3).map((s) => [s.capability, s.tasks])).toEqual([
      ['method', ['memory-question']],
    ]);
  });
});
