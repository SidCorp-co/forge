/**
 * The one writer of assistant preferences and its trail (ISS-1034): every
 * write appends one row per field carried, a restore applies only while the
 * field still holds what that change set, and another person's change is not
 * yours to restore.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

interface PrefRow {
  userId: string;
  answerStyle: string;
  assistantInstructions: string | null;
  updatedAt: Date | null;
}
interface ChangeRow {
  id: string;
  userId: string;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  changedBy: string;
  changedByUserId: string | null;
  conversationId: string | null;
  changedAt: Date;
}
const state: { prefs: Map<string, PrefRow>; changes: ChangeRow[]; clock: number } = {
  prefs: new Map(),
  changes: [],
  clock: 0,
};
let idSeq = 0;

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes('Name'));
  return sym ? String((t as Record<symbol, unknown>)[sym]) : 'unknown';
}

/** A tiny in-memory drizzle: enough of the chain the writer uses, dispatched by table. */
function fakeDb() {
  const currentUser = { id: '' };
  const filters = { userId: '', changeId: '', field: '', after: null as Date | null };
  // The writer only ever filters by userId (and id / field / changedAt for the trail); we read
  // the values off the drizzle SQL wrappers by walking their queryChunks for bound params.
  const params = (cond: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
      if (Array.isArray(n.queryChunks)) n.queryChunks.forEach(walk);
      else if ('value' in n && 'encoder' in n) out.push(n.value);
    };
    walk(cond);
    return out;
  };
  const selectFrom = (table: unknown) => {
    const name = tableName(table);
    const q = {
      where: (cond: unknown) => {
        const p = params(cond);
        if (name.includes('user_preferences')) currentUser.id = String(p[0]);
        else {
          for (const v of p) {
            if (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) && !filters.userId)
              filters.userId = v;
            else if (typeof v === 'string' && /^c-/.test(v)) filters.changeId = v;
            else if (typeof v === 'string' && /_/.test(v)) filters.field = v;
            else if (v instanceof Date) filters.after = v;
          }
        }
        return q;
      },
      orderBy: () => q,
      limit: async () => run(),
      then: (cb: (v: unknown) => unknown) => Promise.resolve(run()).then(cb),
    };
    const run = () => {
      if (name.includes('user_preferences')) {
        const row = state.prefs.get(currentUser.id);
        return row ? [row] : [];
      }
      let rows = state.changes.filter((c) => c.userId === filters.userId);
      if (filters.changeId) rows = rows.filter((c) => c.id === filters.changeId);
      if (filters.field) rows = rows.filter((c) => c.field === filters.field);
      if (filters.after) rows = rows.filter((c) => c.changedAt > (filters.after as Date));
      rows = [...rows].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
      filters.userId = '';
      filters.changeId = '';
      filters.field = '';
      filters.after = null;
      return rows;
    };
    return q;
  };
  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      const name = tableName(table);
      if (name.includes('preference_changes')) {
        for (const v of values as Omit<ChangeRow, 'id' | 'changedAt'>[]) {
          state.changes.push({ ...v, id: `c-${++idSeq}`, changedAt: new Date(++state.clock) });
        }
        return Promise.resolve();
      }
      const v = values as Partial<PrefRow> & { userId: string };
      return {
        onConflictDoUpdate: () => ({
          returning: async () => {
            const prev = state.prefs.get(v.userId) ?? {
              userId: v.userId,
              answerStyle: 'default',
              assistantInstructions: null,
              updatedAt: null,
            };
            const next = { ...prev, ...v, updatedAt: new Date(++state.clock) };
            state.prefs.set(v.userId, next);
            return [next];
          },
        }),
      };
    },
  });
  const db = {
    select: () => ({ from: selectFrom }),
    insert,
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}
const db = fakeDb();
vi.mock('../db/client.js', () => ({ db }));

const {
  listPreferenceChanges,
  PreferenceRestoreConflict,
  readAssistantPreferences,
  restorePreferenceChange,
  writeAssistantPreferences,
} = await import('./preference-changes.js');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const HANDLE = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  state.prefs.clear();
  state.changes.length = 0;
  state.clock = 0;
  idSeq = 0;
});

describe('writeAssistantPreferences', () => {
  it('reads defaults for a person with no row', async () => {
    expect(await readAssistantPreferences(ALICE)).toEqual({
      userId: ALICE,
      answerStyle: 'default',
      assistantInstructions: null,
      updatedAt: null,
    });
  });

  it('appends one trail row per field carried, with the previous value (criterion 58)', async () => {
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { answerStyle: 'concise', assistantInstructions: 'no emoji' },
      actor: { kind: 'assistant', userId: HANDLE },
      conversationId: ROOM,
    });
    const trail = await listPreferenceChanges(ALICE);
    expect(trail).toHaveLength(2);
    expect(trail.map((c) => c.field).sort()).toEqual(['answer_style', 'assistant_instructions']);
    const style = trail.find((c) => c.field === 'answer_style');
    expect(style).toMatchObject({
      previousValue: 'default',
      newValue: 'concise',
      changedBy: 'assistant',
      changedByUserId: HANDLE,
      conversationId: ROOM,
    });
    expect(await readAssistantPreferences(ALICE)).toMatchObject({
      answerStyle: 'concise',
      assistantInstructions: 'no emoji',
    });
  });

  it('a write that re-asserts the same value is still a row — a write is a write', async () => {
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { answerStyle: 'concise' },
      actor: { kind: 'person', userId: ALICE },
    });
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { answerStyle: 'concise' },
      actor: { kind: 'admin', userId: ADMIN },
    });
    const trail = await listPreferenceChanges(ALICE);
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({
      changedBy: 'admin',
      previousValue: 'concise',
      newValue: 'concise',
    });
  });

  it('writes nothing and appends nothing for an empty patch', async () => {
    await writeAssistantPreferences({
      userId: ALICE,
      patch: {},
      actor: { kind: 'person', userId: ALICE },
    });
    expect(await listPreferenceChanges(ALICE)).toHaveLength(0);
  });
});

describe('restorePreferenceChange', () => {
  it('puts the field back while it still holds what the change set (criterion 60)', async () => {
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { assistantInstructions: 'be brief' },
      actor: { kind: 'person', userId: ALICE },
    });
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { assistantInstructions: 'be terse' },
      actor: { kind: 'assistant', userId: HANDLE },
      conversationId: ROOM,
    });
    const [assistantChange] = await listPreferenceChanges(ALICE);
    const restored = await restorePreferenceChange({
      userId: ALICE,
      changeId: assistantChange?.id ?? '',
      actor: { kind: 'person', userId: ALICE },
    });
    expect(restored?.assistantInstructions).toBe('be brief');
    const trail = await listPreferenceChanges(ALICE);
    expect(trail).toHaveLength(3);
    expect(trail[0]).toMatchObject({
      changedBy: 'person',
      previousValue: 'be terse',
      newValue: 'be brief',
    });
  });

  it('refuses naming the later change once the field moved on (criterion 61)', async () => {
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { answerStyle: 'detailed' },
      actor: { kind: 'assistant', userId: HANDLE },
      conversationId: ROOM,
    });
    const [assistantChange] = await listPreferenceChanges(ALICE);
    await writeAssistantPreferences({
      userId: ALICE,
      patch: { answerStyle: 'bullets' },
      actor: { kind: 'person', userId: ALICE },
    });
    const [later] = await listPreferenceChanges(ALICE);
    await expect(
      restorePreferenceChange({
        userId: ALICE,
        changeId: assistantChange?.id ?? '',
        actor: { kind: 'person', userId: ALICE },
      }),
    ).rejects.toBeInstanceOf(PreferenceRestoreConflict);
    try {
      await restorePreferenceChange({
        userId: ALICE,
        changeId: assistantChange?.id ?? '',
        actor: { kind: 'person', userId: ALICE },
      });
    } catch (err) {
      expect((err as InstanceType<typeof PreferenceRestoreConflict>).later?.id).toBe(later?.id);
      expect((err as Error).message).toContain(later?.id);
    }
    expect((await readAssistantPreferences(ALICE)).answerStyle).toBe('bullets');
  });

  it("answers null for a change that is not this person's", async () => {
    await writeAssistantPreferences({
      userId: BOB,
      patch: { answerStyle: 'concise' },
      actor: { kind: 'person', userId: BOB },
    });
    const [bobs] = await listPreferenceChanges(BOB);
    expect(
      await restorePreferenceChange({
        userId: ALICE,
        changeId: bobs?.id ?? '',
        actor: { kind: 'person', userId: ALICE },
      }),
    ).toBeNull();
    expect((await readAssistantPreferences(BOB)).answerStyle).toBe('concise');
  });
});
