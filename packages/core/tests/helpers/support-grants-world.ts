// A support room on its grant (REQ-75 r5 BC-25..BC-28): `support-world.ts`'s world, its project
// binding two Coolify targets (a dev one and a production one) and declaring `dev` as the
// development branch, the room bound with a reading grant. Tests regrant it as a project admin
// would and drive each ability as the session calls it.

import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { rows } from './factories.js';
import { seedDeployBinding, seedProjectDocument } from './release-world.js';
import { SupportWorld } from './support-world.js';

/** The `support` block every test's grant is declared on top of. */
export const BASE = { product: 'Catalog, the shop back office' };

export class GrantedRoom {
  readonly w = new SupportWorld();
  roomId = '';
  devTarget = '';
  liveTarget = '';

  async start(): Promise<void> {
    const { w } = this;
    await w.start();
    this.devTarget = await seedDeployBinding(w.projectId, w.ownerId);
    this.liveTarget = await seedDeployBinding(w.projectId, w.ownerId);
    await seedProjectDocument(w.projectId, w.ownerId, {
      defaultBranch: 'dev',
      promotions: [{ from: 'dev', to: 'main', via: 'merge' }],
      environments: {
        dev: {
          tier: 'dev',
          deploysFrom: 'dev',
          deployment: { binding: this.devTarget, trigger: 'on-request' },
        },
        live: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: { binding: this.liveTarget, trigger: 'on-request' },
        },
      },
    });
    await w.bind({ ...BASE, grants: { abilities: ['read_checkout', 'file_items'] } });
    this.roomId = String((await w.rooms())[0]?.id);
  }

  /**
   * A member asks in the group and the session makes one `forge_support` call for it: the call's
   * answer, and the thread it was asked in.
   */
  async sessionDoes(
    args: Record<string, unknown>,
    text = 'Can you look at this?',
    who = this.w.chat.bob,
  ): Promise<{ thread: string; out: Record<string, unknown> }> {
    const { w } = this;
    await w.settleWarm();
    let out: Record<string, unknown> | null = null;
    let armed = true;
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge' || !armed) continue;
        armed = false;
        out = await act({ ...args, thread: m.thread });
      }
    };
    const thread = await w.chat.say(who, text);
    await expect.poll(() => out, { timeout: 15_000 }).not.toBeNull();
    return { thread, out: out as unknown as Record<string, unknown> };
  }

  /** The room's proposal under `code`: what it waits to do, and what became of it. */
  async proposal(
    code: string,
  ): Promise<{ kind: string; state: string; result: Record<string, unknown> | null } | undefined> {
    return (
      await rows<{ kind: string; state: string; result: Record<string, unknown> | null }>(
        sql`SELECT kind, state, result FROM support_proposals WHERE room_id = ${this.roomId}::uuid AND code = ${code}`,
      )
    )[0];
  }

  /** The Coolify deploys queued for `bindingId`. */
  async deploysQueued(bindingId: string): Promise<number> {
    return (
      (
        await rows<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pgboss_v12.job
           WHERE name = 'forge.integrations' AND data->>'bindingId' = ${bindingId}
             AND data->>'jobKind' = 'coolify.dispatch'`)
      )[0]?.n ?? 0
    );
  }
}
