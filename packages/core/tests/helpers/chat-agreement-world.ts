/**
 * The world the chat-agreement suites hold a chat's writes in (REQ-30 BC-4): a project with an owner
 * and a member, a room between them, a workflow design and a requirement to link to, the owner's
 * Assistant turn toolset behind the agreement gate, and an Agent-mode session answering the room.
 * Real routes, real toolset, real database; the suites only say what they do in it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { AgreementGate, GatedTurn } from '../../src/assistant/agreement/turn-gate.js';
import { type Reply, requester, startQueue, testEnv } from './ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
} from './factories.js';

export type Who = 'owner' | 'member' | 'agent';

export interface AgreementWorld {
  projectId: string;
  projectSlug: string;
  owner: string;
  roomId: string;
  workflowId: string;
  /** A requirement the owner drafted directly, for records to link to. */
  reqKey: string;
  say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
  /** The bearer each speaker `say` sends; `agent` is the latest Agent turn's session token. */
  tokens: Record<string, string>;
  /** The owner's Assistant turn token, which every Assistant tool call of the turn runs under. */
  turnToken: string;
  /** The owner's Assistant toolset for a turn, behind the agreement gate, with the images the turn carries. */
  gate: (recordImages?: GatedTurn['recordImages']) => AgreementGate;
  /** The token of a chat session on the owner's box that answers no room (the Agents screen). */
  noRoomSession: () => Promise<string>;
  /** A new room turn answered in Agent mode: its session token becomes the `agent` speaker. */
  agentTurn: (question: string) => Promise<void>;
}

export async function openAgreementWorld(firstQuestion: string): Promise<AgreementWorld> {
  testEnv();
  const index = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { AGENT_TURN_MENU, CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { createChatSessionRow, mintSessionCredential } = await import(
    '../../src/agent-sessions/index.js'
  );
  const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { agreementGate } = await import('../../src/assistant/agreement/turn-gate.js');
  const { db } = await import('../../src/db/client.js');

  const owner = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(owner);
  const projectId = project.id;
  await addProjectMember(projectId, owner, 'owner');
  await addProjectMember(projectId, member, 'member');
  const deviceId = await createTestDevice(owner);
  const workflowId = randomUUID();
  await db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
    VALUES (${workflowId}, ${projectId}, 'chat-turn', 'flow', 1, '{}'::jsonb, ${owner})`);

  const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const authority = resolved.authority;

  const tokens: Record<string, string> = {
    owner: await signUserToken(owner),
    member: await signUserToken(member),
  };
  const say = requester(index.app, tokens) as AgreementWorld['say'];
  const opened = await say('owner', 'POST', '/api/conversations', {
    projectId,
    title: 'the dock',
    people: [member],
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const roomId = String(opened.json.id);
  const reqKey = (
    await say('owner', 'POST', `/api/projects/${projectId}/requirements`, {
      title: 'The chat dock keeps a draft',
      reason: 'People lose what they typed.',
      criteria: [{ body: 'A draft survives a tab switch.' }],
    })
  ).json.key as string;

  const credential = await mintTurnCredential({ authority, menu: CHAT_TURN_MENU, ttlMs: 600_000 });
  const gate = (recordImages?: GatedTurn['recordImages']) =>
    agreementGate(
      buildProjectToolset(
        buildChatToolContext({
          credential,
          projectSlug: project.slug,
          turn: { conversationId: roomId, speakerUserId: owner, handleUserId: null },
        }),
      ),
      { projectId, conversationId: roomId, personId: owner, handleUserId: null, recordImages },
    );

  // each room turn an Agent-mode box answers is its own session, started when the turn was
  const agentTurn = async (question: string) => {
    const session = await createChatSessionRow({
      projectId,
      userId: owner,
      title: 'Agent: the dock',
      runKind: 'system',
      metadata: {
        conversationAgent: {
          venue: { adapter: 'web', externalId: roomId, projectId },
          conversationId: roomId,
          windowId: randomUUID(),
          deliveryKey: `window:${randomUUID()}`,
          question,
          asker: { userId: owner, viaTokenId: null },
        },
      },
    });
    tokens.agent = await mintSessionCredential({
      sessionId: session.id,
      deviceId,
      value: { authority, menu: AGENT_TURN_MENU },
    });
  };
  await agentTurn(firstQuestion);

  // a session the Agents screen opens answers no room, so it carries no conversation marker
  const noRoomSession = async () => {
    const session = await createChatSessionRow({
      projectId,
      userId: owner,
      title: 'Agents screen',
      runKind: 'system',
    });
    return mintSessionCredential({
      sessionId: session.id,
      deviceId,
      value: { authority, menu: AGENT_TURN_MENU },
    });
  };

  return {
    projectId,
    projectSlug: project.slug,
    owner,
    roomId,
    workflowId,
    reqKey,
    say,
    app: index.app,
    tokens,
    turnToken: credential.token,
    gate,
    agentTurn,
    noRoomSession,
  };
}
