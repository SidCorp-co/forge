// `/api/conversations/:id/proposals` — the chat writes held in a room until the person they wait on
// agrees (REQ-30 BC-4). The person reads them as confirm cards and records or declines one as
// themselves; an Agent-mode session binds the person's reply to one with its own token, which the
// agreement checks (`agree.ts`). A card's agreement is told in the thread, with the record it made.

import {
  AGREE_CHAT_PROPOSAL_SHAPE,
  agreeChatProposalRequestSchema,
  type ChatProposalRefusalCode,
  type ChatProposalSummary,
} from '@forge/contracts/chat-proposals';
import { Hono } from 'hono';
import { z } from 'zod';
import { readableConversation } from '../../conversations/index.js';
import { refuser } from '../../lib/refusal.js';
import type { AuthVars } from '../../middleware/auth.js';
import { strictBody, zValidator } from '../../middleware/zod-validator.js';
import { postServiceAnswer } from '../conversation-adapter.js';
import { agreeProposal, declineAs } from './agree.js';
import { agreementOf, refuseChatDecline } from './agreement-door.js';
import type { WriteOutcome } from './execute.js';
import { type ChatProposalRow, listProposals, readProposal } from './store.js';
import { labels, viewOf } from './views.js';

const refuse = refuser<ChatProposalRefusalCode>('CHAT_PROPOSAL_UNKNOWN');

export const conversationProposalRoutes = new Hono<{ Variables: AuthVars }>();

const roomParam = zValidator('param', z.object({ id: z.uuid() }));
const proposalParam = zValidator('param', z.object({ id: z.uuid(), pid: z.uuid() }));

function toldInThread(row: ChatProposalRow, outcome: WriteOutcome): string {
  const title = (row.summary as ChatProposalSummary).title;
  if (!outcome.ok) return `Not recorded: ${title}. The write was refused: ${outcome.failure}`;
  const ref = outcome.record.ref;
  return ref ? `Recorded as ${ref}: ${title}.` : `Recorded: ${title}.`;
}

conversationProposalRoutes.get('/:id/proposals', roomParam, async (c) => {
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
    const as = await agreementOf(id, proposal, c.get('userId'), c.req.valid('json'));
    const { row, outcome } = await agreeProposal(pid, as);
    if (as.via === 'card') {
      await postServiceAnswer({
        conversationId: id,
        projectId: row.projectId,
        askerUserId: as.userId,
        content: toldInThread(row, outcome),
        blocks: [],
      });
    }
    const named = await labels([row.proposedTo]);
    return c.json({
      proposal: viewOf(row, as.userId, named),
      ...(outcome.ok ? { answered: outcome.answered } : {}),
    });
  },
);

conversationProposalRoutes.post('/:id/proposals/:pid/decline', proposalParam, async (c) => {
  const { id, pid } = c.req.valid('param');
  const userId = c.get('userId');
  await refuseChatDecline();
  await readableConversation(id, userId);
  const proposal = await readProposal(pid);
  if (!proposal || proposal.conversationId !== id) {
    throw refuse('CHAT_PROPOSAL_UNKNOWN', `proposal ${pid} is not one made in conversation ${id}`);
  }
  const row = await declineAs(pid, userId);
  const named = await labels([row.proposedTo]);
  return c.json({ proposal: viewOf(row, userId, named) });
});
