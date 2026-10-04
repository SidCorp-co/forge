import type { NeedsYouProjectItem } from '@forge/contracts/needs-you';
import { Hono } from 'hono';
import { readNeedsYouAcross } from '../development/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  type AttentionFailedJobRow,
  type AttentionMentionRow,
  selectFailedJobs,
  selectMentions,
} from './attention-buckets.js';
import { type AttentionGateRow, selectChannelGates } from './attention-gates.js';

type AttentionKind = 'mention' | 'failed_job' | 'channel_gate';

interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  since: string;
  issueRef?: string;
  status?: string;
  projectSlug?: string;
  projectName?: string;
  questionId?: string | null;
  /** Channel-gate only: the number of the document waiting at the approve gate. */
  documentNumber?: string;
  documentType?: string | null;
}

interface AttentionResponse {
  /** Every project's needs-you rows, read by the one needs-you read model. */
  needsYou: NeedsYouProjectItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  /** Documents waiting at an approve gate that this person's role may decide. */
  channelGates: AttentionItem[];
  total: number;
}

const issueLink = (slug: string, docId: string) => `/projects/${slug}/issues/${docId}`;

function mentionItem(r: AttentionMentionRow): AttentionItem {
  return {
    kind: 'mention',
    title: r.notificationTitle ?? `Mention in ${formatIssueRef(r.issuePrefix, r.issSeq)}`,
    link: issueLink(r.projectSlug, r.issueDocId),
    since: r.mentionedAt.toISOString(),
    issueRef: formatIssueRef(r.issuePrefix, r.issSeq),
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

function failedJobItem(r: AttentionFailedJobRow): AttentionItem {
  const item: AttentionItem = {
    kind: 'failed_job',
    title: r.error ? `${r.type} failed: ${r.error.slice(0, 80)}` : `${r.type} job failed`,
    link: r.issueDocId ? issueLink(r.projectSlug, r.issueDocId) : `/projects/${r.projectSlug}`,
    since: (r.finishedAt ?? r.createdAt).toISOString(),
    status: 'failed',
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
  if (r.issSeq != null) item.issueRef = formatIssueRef(r.issuePrefix, r.issSeq);
  return item;
}

function gateItem(r: AttentionGateRow): AttentionItem {
  return {
    kind: 'channel_gate',
    title: r.prompt,
    link: `/projects/${r.projectSlug}/ecosystem/channel/${r.number}`,
    since: r.createdAt.toISOString(),
    projectSlug: r.projectSlug,
    projectName: r.projectName,
    questionId: r.questionId,
    documentNumber: r.number,
    documentType: r.documentType,
  };
}

export const meAttentionRoutes = new Hono<{ Variables: AuthVars }>();
meAttentionRoutes.use('/attention', requireAuth(), assertEmailVerified());

meAttentionRoutes.get('/attention', async (c) => {
  const userId = c.get('userId');
  const agency = c.get('agency');
  if (!agency) throw new Error('me/attention: a request reached its handler without an auth gate');

  const [needsYou, mentionRows, failedJobRows, channelGateRows] = await Promise.all([
    readNeedsYouAcross(userId, agency),
    selectMentions(userId),
    selectFailedJobs(userId),
    selectChannelGates(userId),
  ]);

  const mentions = mentionRows.map(mentionItem);
  const failedJobs = failedJobRows.map(failedJobItem);
  const channelGates = channelGateRows.map(gateItem);

  const response: AttentionResponse = {
    needsYou,
    mentions,
    failedJobs,
    channelGates,
    total: needsYou.length + mentions.length + failedJobs.length + channelGates.length,
  };

  return c.json(response);
});
