// `/api/conversations/:id/proposals` — the chat writes held in a room until the person they wait on
// agrees (REQ-30 BC-4). The person reads them as confirm cards and records or declines one as
// themselves; no chat credential decides one (`agreement-door.ts`). What the press made, or what
// refused it, is told in the thread in a sentence.

import {
  AGREE_CHAT_PROPOSAL_SHAPE,
  agreeChatProposalRequestSchema,
  CHAT_PROPOSAL_PLAIN_SHAPE,
  type ChatProposalRefusalCode,
  type ChatProposalSummary,
  chatProposalPlainRequestSchema,
} from '@forge/contracts/chat-proposals';
import { plainOf } from '@forge/contracts/plain-decision';
import { Hono } from 'hono';
import { z } from 'zod';
import { readableConversation } from '../../conversations/index.js';
import { refuser } from '../../lib/refusal.js';
import type { AuthVars } from '../../middleware/auth.js';
import { noQuery, strictBody, zValidator } from '../../middleware/zod-validator.js';
import { postServiceAnswer } from '../conversation-adapter.js';
import {
  PROPOSAL_AGREE,
  PROPOSAL_DECLINE,
  PROPOSAL_PLAIN,
  ROOM_READ,
} from '../conversation-declarations.js';
import { agreeProposal, declineAs } from './agree.js';
import { agreementOf, declinerOf } from './agreement-door.js';
import type { WriteOutcome } from './execute.js';
import { failureSentence } from './failure.js';
import { plainWriterOf } from './plain-door.js';
import { type ChatProposalRow, listProposals, readProposal, setProposalPlain } from './store.js';
import { labels, viewOf } from './views.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_PROPOSAL_UNKNOWN');

export const conversationProposalRoutes = new Hono<{ Variables: AuthVars }>();

const roomParam = zValidator('param', z.object({ id: z.uuid() }));
const proposalParam = zValidator('param', z.object({ id: z.uuid(), pid: z.uuid() }));

function toldInThread(row: ChatProposalRow, outcome: WriteOutcome): string {
  const title = (row.summary as ChatProposalSummary).title;
  if (!outcome.ok) return `Not recorded: ${title}. ${failureSentence(outcome.failure)}`;
  const ref = outcome.record.ref;
  return ref ? `Recorded as ${ref}: ${title}.` : `Recorded: ${title}.`;
}

conversationProposalRoutes.get('/:id/proposals', roomParam, ROOM_READ, noQuery, async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  await readableConversation(id, userId);
  const rows = await listProposals(id);
  const named = await labels(rows.map((r) => r.proposedTo));
  return c.json({ proposals: rows.map((r) => viewOf(r, userId, named)) });
});

conversationProposalRoutes.post(
  '/:id/proposals/:pid/agree',
  proposalParam,
  PROPOSAL_AGREE,
  strictBody(agreeChatProposalRequestSchema, AGREE_CHAT_PROPOSAL_SHAPE),
  async (c) => {
    const { id, pid } = c.req.valid('param');
    const proposal = await readProposal(pid);
    if (!proposal || proposal.conversationId !== id) {
      throw refuse(
        'CHAT_PROPOSAL_UNKNOWN',
        `proposal ${pid} is not one made in conversation ${id}`,
      );
    }
    const as = await agreementOf(id, proposal, c.get('userId'));
    const { row, outcome } = await agreeProposal(pid, as);
    await postServiceAnswer({
      conversationId: id,
      projectId: row.projectId,
      askerUserId: as.userId,
      content: toldInThread(row, outcome),
      blocks: [],
    });
    const named = await labels([row.proposedTo]);
    return c.json({
      proposal: viewOf(row, as.userId, named),
      ...(outcome.ok ? { answered: outcome.answered } : {}),
    });
  },
);

// the line the person decides a held REST request from, written by the session that sent it (ISS-1006)
conversationProposalRoutes.put(
  '/:id/proposals/:pid/plain',
  proposalParam,
  PROPOSAL_PLAIN,
  strictBody(chatProposalPlainRequestSchema, CHAT_PROPOSAL_PLAIN_SHAPE),
  async (c) => {
    const { id, pid } = c.req.valid('param');
    const proposal = await readProposal(pid);
    if (!proposal || proposal.conversationId !== id) {
      throw refuse(
        'CHAT_PROPOSAL_UNKNOWN',
        `proposal ${pid} is not one made in conversation ${id}`,
      );
    }
    await plainWriterOf(proposal);
    const row = await setProposalPlain(pid, plainOf(c.req.valid('json').plain));
    if (!row) {
      throw refuse(
        'CHAT_PROPOSAL_SETTLED',
        `proposal ${pid} was decided before its plain line arrived; nothing was written`,
      );
    }
    const named = await labels([row.proposedTo]);
    return c.json({ proposal: viewOf(row, c.get('userId'), named) });
  },
);

conversationProposalRoutes.post(
  '/:id/proposals/:pid/decline',
  proposalParam,
  PROPOSAL_DECLINE,
  async (c) => {
    const { id, pid } = c.req.valid('param');
    const userId = c.get('userId');
    await declinerOf(id, userId);
    const proposal = await readProposal(pid);
    if (!proposal || proposal.conversationId !== id) {
      throw refuse(
        'CHAT_PROPOSAL_UNKNOWN',
        `proposal ${pid} is not one made in conversation ${id}`,
      );
    }
    const row = await declineAs(pid, userId);
    const named = await labels([row.proposedTo]);
    return c.json({ proposal: viewOf(row, userId, named) });
  },
);
