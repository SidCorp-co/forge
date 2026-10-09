// The world a POC room (REQ-44) is driven in: the REQ-41 subjects world, whose box answers a keep
// with a new head and a settle with the merge a test sets, plus the steps every room test takes —
// an agreed screen requirement, a room open and live, an ask, and the agent's turn ending.

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { transitionSessions } from '../../src/agent-sessions/index.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { agentSessions } from '../../src/db/schema.js';
import { api } from './api.js';
import { settleOutbox } from './ecosystem-world.js';
import { SUBJECT_ENVIRONMENTS, SubjectsWorld } from './preview-subjects-world.js';
import { seedProjectDocument } from './release-world.js';

export const ROOM_BASE = 'a'.repeat(40);
export const ROOM_PATCH = 'd'.repeat(40);
export const ROOM_MERGE = 'e'.repeat(40);
const CHANGED = ['web/src/cart.tsx'];

export type Room = {
  id: string;
  state: string;
  detail: string | null;
  data: string;
  branch: string;
  preview: { id: string; state: string; reason: string | null; url: string };
  members: { userId: string; name: string }[];
  turns: {
    id: string;
    seq: number;
    kind: string;
    ask: string;
    shownAt: string | null;
    shownAfterMs: number | null;
    commit: string | null;
  }[];
  items: { id: string; turnId: string; commit: string; text: string }[];
  settle: {
    into: string;
    mergeSha: string | null;
    requirement: string | null;
    revision: number | null;
    issue: { id: string; displayId: string | null } | null;
    refusals: { code: string; detail: string }[];
  } | null;
  canWrite: boolean;
};

/** An rrweb Meta + FullSnapshot pair showing `text`, as the page sends one at settle. */
export const snapshotOf = (text: string) => [
  { type: 4, timestamp: 1, data: { href: 'http://x.invalid/', width: 800, height: 600 } },
  {
    type: 2,
    timestamp: 2,
    data: { node: { type: 0, childNodes: [{ type: 3, textContent: text, id: 2 }], id: 1 } },
  },
];

export class PocRoomWorld extends SubjectsWorld {
  /** The files a keep reports as changed; a test swaps in a schema change. */
  files = CHANGED;
  /** What the box answers a settle with; a test swaps in a refused merge. */
  mergeAnswer: (into: string) => Record<string, unknown> = (into) => ({
    merged: { into, sha: ROOM_MERGE },
  });
  private heads = 0;
  private reqSeq = 9000;
  private fbSeq = 300;

  override async start(): Promise<void> {
    await super.start();
    // the world's issues were written with their numbers by hand; the counter a filed issue takes from is moved past them
    await db.execute(sql`
      INSERT INTO project_iss_counters (project_id, next_seq) VALUES (${this.projectId}, 1000)
      ON CONFLICT (project_id) DO UPDATE SET next_seq = 1000
    `);
    this.box.onSnapshot = (frame) => {
      const settle = frame.settle as { into: string } | undefined;
      return {
        kind: 'snapshot',
        base: ROOM_BASE,
        patchId: ROOM_PATCH,
        files: this.files,
        ...(frame.keep ? { head: this.nextHead() } : {}),
        ...(settle ? this.mergeAnswer(settle.into) : {}),
      };
    };
  }

  /** Each test starts from a change to one file, a merge that lands, and work landing on dev. */
  async reset(): Promise<void> {
    this.files = CHANGED;
    this.mergeAnswer = (into) => ({ merged: { into, sha: ROOM_MERGE } });
    await this.landing('dev', 'main');
  }

  private nextHead(): string {
    this.heads += 1;
    return this.heads.toString(16).padStart(40, 'c');
  }

  nextFeedbackSeq(): number {
    this.fbSeq += 1;
    return this.fbSeq;
  }

  /** The project's document: work lands on `defaultBranch`, production deploys from `deploysFrom`. */
  landing = async (defaultBranch: string, deploysFrom: string, demo = true) => {
    await seedProjectDocument(this.projectId, this.ownerId, {
      defaultBranch,
      environments: {
        ...SUBJECT_ENVIRONMENTS,
        live: { ...SUBJECT_ENVIRONMENTS.live, deploysFrom },
      } as never,
      extra: {
        preview: {
          command: 'npm run dev -- --port {port}',
          ...(demo ? { demo: { environment: 'demo', seed: 'npm run seed:demo' } } : {}),
        },
      },
    });
  };

  /** An agreed screen requirement with one criterion, as the BA leaves one. */
  agreedScreen = async (title: string): Promise<string> => {
    const { projectId, ownerId } = this;
    const [top] = (await db.execute(
      sql`SELECT coalesce(max(req_seq), 0)::int AS n FROM requirements WHERE project_id = ${projectId}::uuid`,
    )) as unknown as { n: number }[];
    this.reqSeq = Math.max(this.reqSeq, top?.n ?? 0) + 1;
    const seq = this.reqSeq;
    const id = randomUUID();
    await withKernelMarker(db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO requirements (id, project_id, req_seq, title, status)
        VALUES (${id}, ${projectId}, ${seq}, ${title}, 'draft')
      `);
      await tx.execute(sql`
        INSERT INTO requirement_revisions
          (requirement_id, revision, state, spec, reason, kind, author_id, author_agency, decided_by, decided_at)
        VALUES (${id}, 1, 'current', '{}'::jsonb, 'first cut', 'screen', ${ownerId}, 'human', ${ownerId}, now())
      `);
      await tx.execute(
        sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE id = ${id}`,
      );
    });
    await db.execute(sql`
      INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
      VALUES (${id}, 'BC-1', 'A buyer sees the cart total.', 1)
    `);
    return `REQ-${seq}`;
  };

  read = async (id: string, who = this.owner) => {
    const got = await api(who, 'GET', `/api/rooms/${id}`);
    return { status: got.status, body: got.body, room: got.body.room as Room };
  };

  /** The room agent's turn ends: its sketch session is `completed`, as a chat session's is. */
  endTurn = async (roomId: string): Promise<void> => {
    const rows = (await db.execute(
      sql`SELECT session_id FROM poc_rooms WHERE id = ${roomId}::uuid`,
    )) as unknown as { session_id: string }[];
    await transitionSessions(db, {
      to: 'completed',
      where: eq(agentSessions.id, rows[0]?.session_id as string),
      actor: { type: 'system' },
      source: 'poc-room-e2e',
    });
  };

  until = async (id: string, pred: (r: Room) => boolean, ms = 20_000): Promise<Room> => {
    await expect
      .poll(async () => pred((await this.read(id)).room), { timeout: ms, interval: 100 })
      .toBe(true);
    return (await this.read(id)).room;
  };

  /** Every agent frame the box heard: each brief, ask and trim the room's agent was sent. */
  turnFrames = (): { event: string; data: Record<string, unknown> }[] => [
    ...this.box.heardOf('agent:start'),
    ...this.box.heardOf('agent:send'),
  ];

  /** A room open and live, its brief taken by the agent and shown. */
  liveRoom = async (about: string, brief = 'Show the cart total in bold'): Promise<Room> => {
    this.serveApp();
    const opened = await api(this.owner, 'POST', `/api/projects/${this.projectId}/rooms`, {
      about,
      brief,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const room = opened.body.room as Room;
    await settleOutbox();
    await this.until(room.id, (r) => r.preview.state === 'live');
    await expect
      .poll(() => this.turnFrames().some((f) => String(f.data.prompt ?? '').includes(brief)), {
        timeout: 15_000,
      })
      .toBe(true);
    await this.endTurn(room.id);
    return this.until(room.id, (r) => r.turns[0]?.commit != null);
  };

  ask = async (id: string, text: string, who = this.owner): Promise<Room> => {
    const sent = await api(who, 'POST', `/api/rooms/${id}/asks`, { text });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    return sent.body.room as Room;
  };
}
