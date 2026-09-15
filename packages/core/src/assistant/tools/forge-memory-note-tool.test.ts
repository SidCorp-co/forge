import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMemoryWrite = vi.fn();
vi.mock('../../memory/write-service.js', () => ({
  runMemoryWrite: (...a: unknown[]) => runMemoryWrite(...(a as [])),
}));
const handleForProject = vi.fn(async () => 'handle-1');
vi.mock('../../conversations/participants.js', () => ({
  handleForProject: (...a: unknown[]) => handleForProject(...(a as [])),
}));
const assertPrincipalIsMember = vi.fn(async () => undefined);
vi.mock('../../mcp/tools/lib.js', () => ({
  assertPrincipalIsMember: (...a: unknown[]) => assertPrincipalIsMember(...(a as [])),
}));

import { forgeMemoryNoteTool } from './forge-memory-note-tool.js';

type Ctx = Parameters<typeof forgeMemoryNoteTool>[0];
const ctx = (turn: Ctx['turn'], boundProjectId: string | null = 'p1'): Ctx =>
  ({ principal: { userId: 'agent-1' }, boundProjectId, projectSlug: 'alpha', turn }) as never;
const call = (c: Ctx, raw: Record<string, unknown>) =>
  (forgeMemoryNoteTool(c).handler as (r: Record<string, unknown>) => Promise<unknown>)(raw);

beforeEach(() => {
  runMemoryWrite.mockReset();
  runMemoryWrite.mockResolvedValue({ id: 'm1', degraded: false, embeddedAt: new Date() });
  handleForProject.mockClear();
  assertPrincipalIsMember.mockClear();
});

describe('forge_memory.note stamps where a note came from', () => {
  it('writes a note row attributed to the speaker, the room and the handle, and to nothing the model chose', async () => {
    const out = await call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }), {
      text: 'deploys go out on Thursdays',
      title: 'deploy day',
    });
    expect(assertPrincipalIsMember).toHaveBeenCalledWith({ userId: 'agent-1' }, 'p1');
    const written = runMemoryWrite.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      projectId: 'p1',
      source: 'note',
      textContent: 'deploy day\n\ndeploys go out on Thursdays',
      metadata: {
        conversationId: 'c1',
        authorUserId: 'alice',
        handleUserId: 'handle-1',
        title: 'deploy day',
      },
    });
    expect(written.sourceRef).toMatch(/^conversation:c1:[0-9a-f-]{36}$/);
    expect(out).toMatchObject({ id: 'm1', sourceRef: written.sourceRef, degraded: false });
  });

  // cm:guard two notes in one turn must be TWO rows: `runMemoryWrite` upserts on the ref, so a ref built from the message id would leave the second note standing on the first one's grave (ISS-1034 criterion 25).
  it('gives two notes from one room two different refs', async () => {
    const c = ctx({ conversationId: 'c1', speakerUserId: 'alice' });
    await call(c, { text: 'one' });
    await call(c, { text: 'two' });
    const refs = runMemoryWrite.mock.calls.map((a) => (a[0] as { sourceRef: string }).sourceRef);
    expect(new Set(refs).size).toBe(2);
  });

  it('refuses a turn whose newest message is from nobody Forge knows, and writes nothing', async () => {
    await expect(
      call(ctx({ conversationId: 'c1', speakerUserId: null }), { text: 'x' }),
    ).rejects.toThrow(/nobody Forge knows/);
    expect(runMemoryWrite).not.toHaveBeenCalled();
  });

  it('refuses a turn that names no room', async () => {
    await expect(call(ctx(undefined), { text: 'x' })).rejects.toThrow(/names no room/);
    await expect(
      call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }, null), { text: 'x' }),
    ).rejects.toThrow(/names no room/);
    expect(runMemoryWrite).not.toHaveBeenCalled();
  });

  // cm:guard the schema is read for the arguments it does NOT declare: `forge_memory.write`'s `source`, `sourceRef` and `metadata` are how a room would file under `knowledge` or `policy`, and the assertion that a `source` argument is refused whole is what makes "never a source other than note" a fact (ISS-1034 criteria 24, 27).
  it('takes only text and an optional title, and refuses a source', async () => {
    const schema = forgeMemoryNoteTool(ctx(undefined)).inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['text', 'title']);
    expect(schema.required).toEqual(['text']);
    await expect(
      call(ctx({ conversationId: 'c1', speakerUserId: 'alice' }), {
        text: 'x',
        source: 'policy',
      }),
    ).rejects.toThrow();
    expect(runMemoryWrite).not.toHaveBeenCalled();
  });
});
