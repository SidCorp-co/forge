import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/reference-acts.ts
// @direct-test-of packages/core/src/support/reference-cards.ts
// @direct-test-of packages/core/src/support/reference-routes.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/support/room-conduct.ts
// @direct-test-of packages/contracts/src/support-references.ts
//
// ISS-1252 (owner 2026-11-16): he adds a source in plain words to the agent he talks to, and that
// agent records it; bots consult the project's sources first. A room agent reaches the references
// module through four acts: it reads the sources, adds one as the person whose message asked for it
// (under that person's own Forge permission), cites a use as its own, and proposes one it kept using.

const w = new AgentWorld();
const ORCA = 'https://github.com/stablyai/orca';

beforeAll(async () => {
  await w.openAgent();
  // alice's chat account is the Forge account that owns the project's organization; bob is nobody's
  const namespace = new URL(w.stand.serverUrl).host;
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespace}, ${w.stand.alice.userId}, ${w.stand.alice.username}, ${w.ownerId}, 'channel_email_match')`);
}, 120_000);

afterAll(() => w.stop());

type Source = { origin: string; added_by: string; added_agency: string; title: string };
const sources = () =>
  rows<Source>(
    sql`SELECT origin, added_by, added_agency, title FROM reference_sources
         WHERE project_id = ${w.projectId}::uuid AND removed_at IS NULL ORDER BY added_at`,
  );

describe('the owner’s “follow X for Y” is added as his, by the agent he said it to', () => {
  it('adds the source as the writer of the message it cites, and refuses it twice by name', async () => {
    let added: Record<string, unknown> = {};
    let again: Record<string, unknown> = {};
    await w.hear(
      () =>
        w.stand.say(
          w.stand.alice,
          '@babo follow stablyai/orca for how it runs agents in worktrees',
        ),
      async (_t, act, message) => {
        const { thread, message: id } = message();
        const add = {
          action: 'reference_add',
          thread,
          message: id,
          kind: 'repo',
          url: ORCA,
          why: 'parallel CLI agents in isolated git worktrees',
          areas: ['worktrees'],
          followReleases: true,
        };
        added = await act(add);
        again = await act(add);
        await act({ action: 'reply', thread, text: 'Added stablyai/orca for worktrees.' });
      },
    );
    expect(added.isError, JSON.stringify(added)).toBe(false);
    expect(added).toMatchObject({ act: 'added', as: w.stand.alice.username });
    expect(code(again)).toBe('REFERENCE_SOURCE_DUPLICATE');
    // his add, not the room agent's: the speaker is recorded as who added it, in his own words
    expect(await sources()).toEqual([
      { origin: 'added', added_by: w.ownerId, added_agency: 'human', title: 'stablyai/orca' },
    ]);
  });

  it('adds nothing for a writer Forge cannot name, saying why', async () => {
    let out: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.bob, '@babo follow https://example.com/handbook for refunds'),
      async (_t, act, message) => {
        const { thread, message: id } = message();
        out = await act({
          action: 'reference_add',
          thread,
          message: id,
          kind: 'doc',
          url: 'https://example.com/handbook',
          why: 'how refunds are handled',
          areas: ['refunds'],
        });
        await act({ action: 'silent', thread, message: id, reason: 'not his to add' });
      },
    );
    expect(code(out)).toBe('OPS_ASKER_UNMAPPED');
    expect((await sources()).map((s) => s.title)).toEqual(['stablyai/orca']);
  });
});

describe('the agent reads the sources first, cites a use, and proposes one it kept using', () => {
  it('reads by area, cites as its own, and refuses a source the project does not list', async () => {
    let read: Record<string, unknown> = {};
    let cited: Record<string, unknown> = {};
    let unknown: Record<string, unknown> = {};
    let proposed: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.alice, 'how should parallel builds share one checkout?'),
      async (_t, act, message) => {
        const { thread } = message();
        read = await act({ action: 'references', area: 'worktrees' });
        cited = await act({
          action: 'reference_cite',
          source: 'stablyai/orca',
          ref: 'src/worktrees/create.ts',
          verdict: 'take',
          why: 'one worktree per task, removed when the task lands',
        });
        unknown = await act({
          action: 'reference_cite',
          source: 'nobody/nothing',
          ref: 'README.md',
          verdict: 'reject',
          why: 'not a source of this project',
        });
        proposed = await act({
          action: 'reference_propose',
          kind: 'doc',
          url: 'https://git-scm.com/docs/git-worktree',
          why: 'what a worktree shares with its repository',
          areas: ['worktrees'],
          evidence: 'used on three answers about parallel builds this week',
        });
        await act({
          action: 'reply',
          thread,
          text: 'One worktree per build, as stablyai/orca does.',
        });
      },
    );
    expect(read.isError, JSON.stringify(read)).toBe(false);
    expect((read.sources as { title: string }[]).map((s) => s.title)).toEqual(['stablyai/orca']);
    expect(cited).toMatchObject({ act: 'cited', source: 'stablyai/orca', verdict: 'take' });
    expect(code(unknown)).toBe('SUPPORT_REFERENCE_UNKNOWN');
    expect(proposed).toMatchObject({ act: 'proposed' });
    // the citation and the proposal are the room agent's own, never a person's
    const [room] = await rows<{ principal_user_id: string }>(
      sql`SELECT principal_user_id FROM support_rooms WHERE project_id = ${w.projectId}::uuid LIMIT 1`,
    );
    expect(
      await rows(sql`SELECT cited_by, cited_agency FROM reference_citations
                      WHERE project_id = ${w.projectId}::uuid`),
    ).toEqual([{ cited_by: room?.principal_user_id, cited_agency: 'agent' }]);
    expect((await sources()).at(-1)).toMatchObject({
      origin: 'proposed',
      added_by: room?.principal_user_id,
      added_agency: 'agent',
    });
  });

  it('teaches each act by its card: reading first on every brief, the owner’s add where he speaks', () => {
    expect(w.brief()).toContain('support.references { project, area or q }');
    expect(w.brief()).toContain('support.reference_add citing his message');
  });
});
