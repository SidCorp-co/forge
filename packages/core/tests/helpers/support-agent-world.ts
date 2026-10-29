import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { createTestIssue, createTestProject, rows } from './factories.js';
import { seedDeployBinding, seedProjectDocument } from './release-world.js';
import { type Act, ChannelWorld } from './support-channel.js';
import type { StandInRocketChat } from './support-chat-server.js';
import type { Member, Turn, TurnMessage } from './support-world.js';

// REQ-77's channel agent as its behaviour tests drive it (ISS-764): the project's one rocketchat
// binding carries `agent` over two groups of the stand-in chat server, each group's record seeded as
// a person sets it, a home project for Forge's own feedback, and one issue the owner's answers can
// be written on. A member writes, the session runs what a test scripts, and the thread reads back.

export const dave: Member = { userId: 'u-dave', username: 'dave' };
export const zed: Member = { userId: 'u-zed', username: 'zed' };
export const OWNER_ID = 'u-alice';

/** The agent's binding block; `deployTargets` is filled once the dev target exists. */
export const agentBlock = (deployTargets: string[]) => ({
  product: 'Catalog, the shop back office',
  readers: 'team',
  grants: {
    abilities: ['file_items', 'deploy'],
    deployTargets,
    confirmers: ['zed'],
    // the owner the agent asks; no owner_mode, so alice holds no power by it
    owner: OWNER_ID,
  } as Record<string, unknown>,
});

export class AgentWorld extends ChannelWorld {
  stand!: StandInRocketChat;
  devTarget = '';
  home = '';
  issueKey = '';
  issueId = '';

  /** The world started, bound as a channel agent over both groups, and its records seeded. */
  async openAgent(): Promise<void> {
    await this.start();
    this.stand = this.chat as StandInRocketChat;
    this.devTarget = await seedDeployBinding(this.projectId, this.ownerId);
    await seedProjectDocument(this.projectId, this.ownerId, {
      defaultBranch: 'dev',
      environments: {
        dev: {
          tier: 'dev',
          deploysFrom: 'dev',
          deployment: { binding: this.devTarget, trigger: 'on-request' },
        },
      },
    });
    await this.bindTarget({
      rids: [this.stand.rid, this.stand.rid2],
      agent: agentBlock([this.devTarget]),
    });
    // the record a person sets on each group's page: carol is Technical, alice Product, bob a User
    this.rid = this.stand.rid;
    for (const [u, body] of [
      ['alice', { roles: ['user', 'product'], askFor: 'what the shop should do' }],
      ['carol', { roles: ['technical'], askFor: 'DNS and the mail hosts' }],
      ['bob', { roles: ['user'] }],
    ] as const) {
      const put = await this.confirm(u, body);
      if (put.status !== 200) throw new Error(`seeding @${u}: ${JSON.stringify(put.body)}`);
    }
    this.rid = this.stand.rid2;
    const put = await this.confirm('erin', { roles: ['maintenance'], askFor: 'the nightly jobs' });
    if (put.status !== 200) throw new Error(`seeding @erin: ${JSON.stringify(put.body)}`);
    this.rid = this.stand.rid;
    // Forge's own home project, where a problem with Forge is filed
    this.home = (await createTestProject(this.ownerId)).id;
    await rows(sql`
      INSERT INTO instance_settings (id, forge_home_project_id, revision, updated_by)
      VALUES (1, ${this.home}, 1, ${this.ownerId})
      ON CONFLICT (id) DO UPDATE SET forge_home_project_id = EXCLUDED.forge_home_project_id`);
    const issue = await createTestIssue(this.projectId, this.ownerId, 7641, {
      status: 'open',
      createdAt: new Date(),
    });
    this.issueKey = issue.key;
    this.issueId = issue.id;
  }

  /** The brief the agent's session was last started with. */
  brief(): string {
    return this.box.turns.filter((t) => t.event === 'agent:start').at(-1)?.text ?? '';
  }

  /**
   * `send` writes a message; the session runs `does` on the first turn that carries a member message
   * after it, and the turn it ran in comes back with the message id.
   */
  async hear(
    send: () => Promise<string>,
    does: (turn: Turn, act: Act, message: () => TurnMessage) => Promise<void> = async () => {},
  ): Promise<{ id: string; turn: Turn; message: TurnMessage }> {
    await this.settleWarm();
    let seen: Turn | null = null;
    let finished = false;
    let id = '';
    this.box.model = async (turn, act) => {
      if (seen || !turn.messages.some((m) => m.from !== 'forge')) return;
      seen = turn;
      await does(turn, act as Act, () => {
        const m =
          turn.messages.find((x) => x.message === id) ??
          turn.messages.find((x) => x.from !== 'forge');
        return m as TurnMessage;
      });
      finished = true;
    };
    id = await send();
    await expect.poll(() => finished, { timeout: 20_000 }).toBe(true);
    const turn = seen as unknown as Turn;
    return { id, turn, message: turn.messages.find((m) => m.message === id) as TurnMessage };
  }

  /** The lines the bot posted in a thread of a group, oldest first. */
  threadLines(rid: string, thread: string) {
    return this.stand.linesIn(rid).filter((l) => l.tmid === thread);
  }

  /** Wait until a thread holds a line the bot posted that `is` true of; on timeout, say what it holds. */
  async untilLine(
    rid: string,
    thread: string,
    is: (text: string) => boolean,
    timeout = 15_000,
  ): Promise<string> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = this.threadLines(rid, thread).find((l) => is(l.text));
      if (found) return found.text;
      await new Promise((r) => setTimeout(r, 100));
    }
    const refused = await rows<{ tool: string; output: unknown }>(sql`
      SELECT tool, output FROM support_actions
       WHERE project_id = ${this.projectId}::uuid AND thread = ${thread} AND kind = 'refused'`);
    throw new Error(
      `no such line in thread ${thread}; the bot posted ${JSON.stringify(this.threadLines(rid, thread).map((l) => l.text))}; refused ${JSON.stringify(refused)}`,
    );
  }
}
