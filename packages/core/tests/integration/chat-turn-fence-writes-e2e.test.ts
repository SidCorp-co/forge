/**
 * Every write a chat turn makes is held to the role of the person asking (REQ-30 BC-10 and BC-4;
 * workflow design chat-turn r2, steps `perms` and `denied`). Both modes are planted: the Assistant's
 * turn token, which its in-process tools and its `forge` CLI carry, and an Agent session's token,
 * which its shell sends to REST and /mcp. A viewer is refused by the permission it lacks; an owner
 * passes the role and meets the hold that waits for their go-ahead.
 */
// @direct-test-of packages/core/src/standing/tool.ts
// @direct-test-of packages/core/src/steward-notes/tool.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AskerWorld, MODES, openAskerWorld } from '../helpers/chat-fence-world.js';
import { closeWorld, ok } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';

let w: AskerWorld;

beforeAll(async () => {
  w = await openAskerWorld();
  const viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.home.id, viewer, 'viewer');
  await w.seat('viewer', viewer, w.home.id, w.asker);
}, 180_000);

afterAll(closeWorld);

const count = async (table: string): Promise<number> =>
  Number(
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE project_id = ${w.home.id}`,
      )
    )[0]?.n,
  );

/** Every tool the Assistant is offered, each either a write the test plants or why it is not one. */
const NOT_A_PROJECT_WRITE: Record<string, string> = {
  forge: 'its writes are the REST calls its token makes, planted below over REST',
  forge_knowledge: 'chat offers only list, get and search',
  forge_memory: 'chat offers only search',
  forge_preferences: "the person's own account settings, which every role holds for itself",
  forge_project_pipeline_runs:
    'pause, resume and cancel need pipeline:write, which no chat token holds',
  forge_project_status: 'a read',
  forge_requirements: 'a read',
  forge_requirement: 'a read',
  forge_releases: 'a read',
  forge_release: 'a read',
  forge_decisions: 'a read',
  forge_needs_you: 'a read',
  forge_standing: 'a read',
  forge_recording: 'a read: a diagnosis it is given is checked and answered, never written',
  forge_metrics_project_step_durations: 'a read',
  forge_metrics_project_timeseries: 'a read',
  forge_report: "a run of a query, kept as the asker's own read",
  forge_show: 'draws a block of a run this turn made into the room',
  forge_template: "a template run, kept as the asker's own read",
};

/** A steward note a member could write on the project's first requirement (REQ-48 BC-7). */
const stewardNoteWrite = (): Record<string, unknown> => ({
  projectId: w.home.id,
  action: 'write',
  subjectKind: 'requirement',
  key: 'REQ-1',
  note: {
    lines: ['A viewer writes the steward note.'],
    cites: [{ kind: 'requirement', ref: 'REQ-1' }],
    claims: {
      group: 'moving',
      waitingKind: 'agent',
      ref: null,
      stuck: false,
      stuckCode: null,
      dueAt: null,
    },
    basis: 'basis',
    runId: null,
  },
});

/** Each write tool, a call a member could make, and the permission a viewer is refused it by. */
const viewerWrites = (): [string, Record<string, unknown>, string][] => [
  [
    'project_feedback',
    { kind: 'bug', title: 'Viewer feedback', target: { kind: 'screen', ref: '/board' } },
    'project.write',
  ],
  [
    'forge_requirement_draft',
    { title: 'Viewer requirement', reason: 'A viewer asked.', criteria: [{ body: 'It holds.' }] },
    'project.write',
  ],
  [
    'forge_requirement_revise',
    {
      requirement: 'REQ-7',
      baseRevision: null,
      reason: 'A viewer asked.',
      criteria: [{ body: 'It holds.' }],
    },
    'project.write',
  ],
  ['forge_memory_note', { text: 'A viewer remembers this.' }, 'project.write'],
  ['forge_template_save', { templateId: 'status', runIds: [randomUUID()] }, 'project.write'],
  [
    'forge_compute',
    { language: 'javascript', script: 'return { frames: [] }', inputs: [] },
    'assistant.exec',
  ],
  [
    'forge_channel',
    {
      action: 'draft',
      ecosystem: randomUUID(),
      type: 'rfi',
      to: [randomUUID()],
      subject: 'x',
      body: {},
    },
    'project.write',
  ],
];

const restWrites = (): [string, string, string, unknown][] => [
  [
    'feedback',
    'POST',
    `/api/projects/${w.home.id}/feedback`,
    { kind: 'bug', title: 'Viewer feedback', screen: '/board' },
  ],
  [
    'a requirement',
    'POST',
    `/api/projects/${w.home.id}/requirements`,
    { title: 'Viewer requirement', reason: 'A viewer asked.', criteria: [{ body: 'It holds.' }] },
  ],
  ['a comment', 'POST', `/api/issues/${w.homeIssue}/comments`, { body: 'A viewer comments.' }],
  ['an issue field', 'PATCH', `/api/issues/${w.homeIssue}`, { priority: 'high' }],
];

describe("every write a turn makes is held to the asker's own role", () => {
  for (const mode of MODES) {
    it(`refuses each REST write of a viewer's ${mode} token, by the permission it lacks`, async () => {
      const tables = ['feedback', 'requirements', 'knowledge_entries'];
      const before = await Promise.all(tables.map(count));
      for (const [what, method, path, body] of restWrites()) {
        const r = await w.say(`viewer:${mode}`, method, path, body);
        expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(403);
        expect(JSON.stringify(r.json), what).toContain('project.write');
      }
      expect(await Promise.all(tables.map(count))).toEqual(before);
      const issue = ok(await w.say('person', 'GET', `/api/issues/${w.homeIssue}`));
      expect(issue.priority).toBe('medium');
      expect(issue.comments ?? []).toHaveLength(0);
    });
  }

  // a knowledge entry reaches every prompt, so no card carries it: a chat is refused it by name
  // whatever the asker's role (REQ-30 BC-4, ISS-439 round 3), and nothing is written
  it('refuses a knowledge entry from every chat token, viewer and owner alike', async () => {
    const before = await count('knowledge_entries');
    for (const who of MODES.flatMap((mode) => [`viewer:${mode}`, `asker:${mode}`])) {
      const r = await w.say(who, 'PUT', `/api/projects/${w.home.id}/knowledge/viewer-note`, {
        title: 'Viewer note',
        body: 'A viewer writes.',
      });
      expect(r.status, `${who}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(JSON.stringify(r.json), who).toContain('CHAT_WRITE_REFUSED');
    }
    expect(await count('knowledge_entries')).toBe(before);
  });

  // an owner's chat write passes the role check and meets the hold that waits for the person to
  // agree (ISS-439, REQ-30 BC-4): not the viewer's permission refusal, so the role is what refused it
  it("lets the same write past the role for an owner's token, to wait for their go-ahead", async () => {
    const before = await count('feedback');
    for (const mode of MODES) {
      const r = await w.say(`asker:${mode}`, 'POST', `/api/projects/${w.home.id}/feedback`, {
        kind: 'bug',
        title: `Owner feedback (${mode})`,
        screen: '/board',
      });
      expect(r.status, `${mode}: ${JSON.stringify(r.json)}`).toBe(409);
      expect(JSON.stringify(r.json), mode).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
      expect(JSON.stringify(r.json), mode).not.toContain('project.write');
    }
    expect(await count('feedback')).toBe(before);
  });

  it('classifies every tool the Assistant is offered, so a new write cannot join unplanted', () => {
    const offered = w.tools('viewer').tools.map((t) => t.function.name);
    const planted = [...viewerWrites().map(([name]) => name), 'forge_steward_note'];
    const unclassified = offered.filter((n) => !planted.includes(n) && !(n in NOT_A_PROJECT_WRITE));
    expect(
      unclassified,
      'offered tools that are neither a planted write nor named a non-write',
    ).toEqual([]);
    for (const name of planted) expect(offered, name).toContain(name);
  });

  it("refuses each of the Assistant's write tools for a viewer, and writes nothing", async () => {
    const set = w.tools('viewer');
    const tables = ['feedback', 'requirements', 'memories'];
    const before = await Promise.all(tables.map(count));
    for (const [name, args, permission] of viewerWrites()) {
      const r = await set.execute(name, JSON.stringify(args));
      expect(r.isError, `${name}: ${w.text(r)}`).toBe(true);
      expect(w.text(r), name).toContain(`needs ${permission}`);
    }
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  // a steward note is the steward's or a person's override on the page (REQ-48 BC-7, BC-12); no
  // confirm card carries one, so the Assistant is offered it as a read and refused its write by name
  it('refuses the steward note write from chat: a viewer at its door, an owner at the gate', async () => {
    const { agreementGate } = await import('../../src/assistant/agreement/turn-gate.js');
    const before = await count('steward_notes');
    const viewer = await w
      .tools('viewer')
      .execute('forge_steward_note', JSON.stringify(stewardNoteWrite()));
    expect(viewer.isError, w.text(viewer)).toBe(true);
    expect(w.text(viewer)).toContain('STEWARD_NOTE_FORBIDDEN');
    const owner = agreementGate(w.tools('asker'), {
      projectId: w.home.id,
      conversationId: randomUUID(),
      personId: w.asker,
      handleUserId: null,
    }).tools;
    const write = await owner.execute('forge_steward_note', JSON.stringify(stewardNoteWrite()));
    expect(write.isError, w.text(write)).toBe(true);
    expect(w.text(write)).toContain('CHAT_WRITE_REFUSED');
    const read = await owner.execute(
      'forge_steward_note',
      JSON.stringify({
        projectId: w.home.id,
        action: 'get',
        subjectKind: 'requirement',
        key: 'REQ-1',
      }),
    );
    expect(w.text(read)).not.toContain('CHAT_WRITE_REFUSED');
    expect(await count('steward_notes')).toBe(before);
  });

  // a channel document speaks to another project's team, which no card in this room answers for:
  // an Agent session is refused it over /mcp by name, whatever its role (ISS-439 round 3)
  it("refuses a viewer's Agent session the channel write it makes over /mcp", async () => {
    const draft = viewerWrites().find(([name]) => name === 'forge_channel');
    if (!draft) throw new Error('the channel draft is not planted');
    const r = await w.callMcp('viewer:agent', 'forge_channel', draft[1]);
    expect(r.result?.isError, JSON.stringify(r)).toBe(true);
    expect(JSON.stringify(r)).toContain('CHAT_WRITE_REFUSED');
    expect(JSON.stringify(r)).toContain('channel document');
  });
});
