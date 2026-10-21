/**
 * The world the chat-turn fence suites plant a turn in (REQ-30 BC-10; workflow design chat-turn r2,
 * steps `perms` and `denied`), in both of its modes: the Assistant's turn token, which its in-process
 * tools and its `forge` CLI carry, and an Agent session's token, which its shell sends to REST and
 * /mcp. Real routes, real toolset, real database; the suites only say what they do in it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { ChatToolset } from '../../src/assistant/tools/mcp-adapter.js';
import type { ChatTurnFacts } from '../../src/lib/tool.js';
import {
  type Doc,
  type EcosystemWorld,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from './ecosystem-world.js';
import {
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestRunSession,
  createTestUser,
  rows,
} from './factories.js';

export type Mode = 'assistant' | 'agent';
export const MODES: readonly Mode[] = ['assistant', 'agent'];

/** The title every record of the other project carries, so a leak of any of them reads by name. */
export const OTHER = 'Payroll export for the other project';

export interface FenceWorld {
  /** The bearer each speaker sends: `person`, each seated `<key>:<mode>`, and any a suite adds. */
  tokens: Record<string, string>;
  say: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
  /** One `tools/call` on /mcp as `who`, answered as its JSON-RPC reply. */
  callMcp: (who: string, name: string, args: Record<string, unknown>) => Promise<Doc>;
  /** The Assistant's toolset for a turn of the person seated as `who`. */
  tools: (who: string, turn?: Partial<ChatTurnFacts>) => ChatToolset;
  text: (r: Awaited<ReturnType<ChatToolset['execute']>>) => string;
  /**
   * Seats `userId` on `projectId` in both modes, as `<key>:assistant` and `<key>:agent`. The Agent
   * session runs on a box `holderId` holds, with a token that may write everything, so a write
   * refused to it is the asker's role and never the box's.
   */
  seat: (key: string, userId: string, projectId: string, holderId?: string) => Promise<void>;
}

/** The fence over an app already booted, with the bearers the world it came from holds. */
export async function fenceWorld(
  app: EcosystemWorld['app'],
  tokens: Record<string, string>,
): Promise<FenceWorld> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  const { AGENT_TURN_MENU, CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { createChatSessionRow, mintSessionCredential, resolveSessionAuthority } = await import(
    '../../src/agent-sessions/index.js'
  );
  const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { toolResultText } = await import('../../src/assistant/tools/mcp-adapter.js');

  const minted: Record<string, Awaited<ReturnType<typeof mintTurnCredential>>> = {};

  const seat: FenceWorld['seat'] = async (key, userId, projectId, holderId = userId) => {
    const resolved = await resolveTurnAuthority({ userId, projectId, viaTokenId: null });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    minted[key] = await mintTurnCredential({
      authority: resolved.authority,
      menu: CHAT_TURN_MENU,
      ttlMs: 10 * 60_000,
    });
    tokens[`${key}:assistant`] = minted[key].token;
    const holder = await createTestDevice(holderId);
    await mintPat({
      userId: holderId,
      name: deviceTokenNameFor(holder),
      permissions: ['*'],
      deviceId: holder,
    });
    const session = await createChatSessionRow({
      projectId,
      userId,
      title: 'Chat: fence',
      runKind: 'system',
      runMetadata: { source: 'conversation.agentTurn' },
      metadata: { conversationAgent: { conversationId: randomUUID() } },
    });
    const authority = await resolveSessionAuthority({
      asker: { userId, viaTokenId: null },
      projectId,
      deviceId: holder,
    });
    if (!authority.ok) throw new Error(authority.refusal.message);
    expect(authority.value.menu).toEqual(AGENT_TURN_MENU);
    tokens[`${key}:agent`] = await mintSessionCredential({
      sessionId: session.id,
      deviceId: holder,
      value: authority.value,
    });
  };

  const tools: FenceWorld['tools'] = (who, turn) => {
    const credential = minted[who];
    if (!credential) throw new Error(`no turn credential for ${who}`);
    return buildProjectToolset(
      buildChatToolContext({
        credential,
        projectSlug: 'fence',
        turn: {
          conversationId: randomUUID(),
          speakerUserId: credential.principal.userId,
          handleUserId: null,
          ...turn,
        },
      }),
    );
  };

  const callMcp: FenceWorld['callMcp'] = async (who, name, args) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens[who]}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Doc;
  };

  return { tokens, say: requester(app, tokens), callMcp, tools, text: toolResultText, seat };
}

export interface AskerWorld extends FenceWorld {
  /** The person asking, signed in as `person` and seated on `home` as `asker`. */
  asker: string;
  home: { id: string; orgId: string };
  /** An open issue of `home`, ISS-1; `home` also holds REQ-7 "Home requirement". */
  homeIssue: string;
}

/** The app booted bare, and the person asking, owner of the project the turn answers. */
export async function openAskerWorld(): Promise<AskerWorld> {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');

  const asker = (await createTestUser({ verified: true })).id;
  const { id, orgId } = await createTestProject(asker);
  const homeIssue = (await createTestIssue(id, asker, 1, { status: 'open', createdAt: new Date() }))
    .id;
  await createTestRequirement(id, 7, 'Home requirement');

  const f = await fenceWorld(app, { person: await signUserToken(asker) });
  await f.seat('asker', asker, id);
  return { ...f, asker, home: { id, orgId }, homeIssue };
}

/**
 * A second project the asker owns, in `home`'s org, so only the turn's fence keeps it out: ISS-1,
 * REQ-1 and FB-1, each titled {@link OTHER}, and a pipeline run.
 */
export async function addOtherProject(
  w: AskerWorld,
): Promise<{ id: string; issue: string; run: string }> {
  const { id } = await createTestProject(w.asker, { orgId: w.home.orgId });
  const at = new Date();
  const issue = (await createTestIssue(id, w.asker, 1, { status: 'open', createdAt: at })).id;
  await createTestRequirement(id, 1, OTHER);
  await createTestFeedback(id, w.asker, 1);
  await rows(sql`UPDATE issues SET title = ${OTHER} WHERE id = ${issue}`);
  await rows(sql`UPDATE feedback SET title = ${OTHER} WHERE project_id = ${id}`);
  const run = await createTestRunSession(id, await createTestDevice(w.asker), at, null);
  return { id, issue, run };
}
