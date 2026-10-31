import type { NeedsYouProjectDecisions } from '@forge/contracts/needs-you-decisions';
import { inActiveOrg } from '@forge/contracts/org-scope';
import { Hono } from 'hono';
import { z } from 'zod';
import { readNeedsYouAcross } from '../development/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { listVisibleProjectsWithRole } from '../projects/index.js';
import {
  type AttentionFailedJobRow,
  type AttentionMentionRow,
  type AttentionStatusReportRow,
  selectFailedJobs,
  selectMentions,
  selectOfflineDevices,
  selectStatusReports,
} from './attention-buckets.js';
import { type AttentionGateRow, selectChannelGates } from './attention-gates.js';

type AttentionKind = 'mention' | 'failed_job' | 'channel_gate' | 'status_report' | 'runner_offline';

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
  /** Offline-runner only: the device's name. */
  deviceName?: string;
}

interface AttentionResponse {
  /** Every project's needs-you rows, read by the one needs-you read model. */
  /** Each project's Needs you, as its own page counts it (REQ-48 BC-11). */
  needsYou: NeedsYouProjectDecisions[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  /** Documents waiting at an approve gate that this person's role may decide. */
  channelGates: AttentionItem[];
  /** Status reports sent to this person that they have not opened. */
  statusReports: AttentionItem[];
  /** The caller's devices that are offline, never narrowed by an org: a device-level alert must not vanish. */
  offlineRunners: AttentionItem[];
  /** The rows each bucket holds, as core counts them, so a screen shows no count of its own. */
  counts: {
    mentions: number;
    failedJobs: number;
    channelGates: number;
    statusReports: number;
    offlineRunners: number;
  };
  /**
   * The decisions waiting on you across your projects: the sum of each project's Needs you `total`,
   * the number its Approvals page heads and its menu badge carries, so the phone's Attention tab and
   * the rail's Overview read the same figure the pages add up to (REQ-48 r3 BC-17).
   */
  waitingOnYou: number;
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

function statusReportItem(r: AttentionStatusReportRow): AttentionItem {
  return {
    kind: 'status_report',
    title: r.title,
    link: `/projects/${r.projectSlug}/status?tab=history&report=${r.reportId}`,
    since: r.deliveredAt.toISOString(),
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

export const meAttentionRoutes = new Hono<{ Variables: AuthVars }>();
meAttentionRoutes.use('/attention', requireAuth(), assertEmailVerified());

const attentionQuery = zValidator('query', z.object({ orgId: z.uuid().optional() }).strict());

meAttentionRoutes.get('/attention', attentionQuery, async (c) => {
  const { orgId } = c.req.valid('query');
  const userId = c.get('userId');
  const agency = c.get('agency');
  if (!agency) throw new Error('me/attention: a request reached its handler without an auth gate');

  const [
    allNeedsYou,
    mentionRows,
    failedJobRows,
    channelGateRows,
    statusReportRows,
    offlineDevices,
    visible,
  ] = await Promise.all([
    readNeedsYouAcross(userId, agency),
    selectMentions(userId),
    selectFailedJobs(userId),
    selectChannelGates(userId),
    selectStatusReports(userId),
    selectOfflineDevices(userId),
    listVisibleProjectsWithRole(userId),
  ]);

  // the active org's projects; a row with no project (a device alert) is always kept
  const inScope = new Set(visible.filter((p) => inActiveOrg(p, orgId ?? null)).map((p) => p.slug));
  const keep = (it: AttentionItem) => !it.projectSlug || inScope.has(it.projectSlug);
  const needsYou = allNeedsYou.filter((n) => inScope.has(n.projectSlug));
  const mentions = mentionRows.map(mentionItem).filter(keep);
  const failedJobs = failedJobRows.map(failedJobItem).filter(keep);
  const channelGates = channelGateRows.map(gateItem).filter(keep);
  const statusReports = statusReportRows.map(statusReportItem).filter(keep);
  const offlineRunners = offlineDevices.map(
    (d): AttentionItem => ({
      kind: 'runner_offline',
      title: d.name,
      deviceName: d.name,
      link: '/runners',
      since: (d.lastSeenAt ?? d.createdAt).toISOString(),
      status: 'offline',
    }),
  );

  // every project the caller sees, whatever the active org: the Attention tab and the rail badge read it
  const waitingOnYou = allNeedsYou.reduce((n, p) => n + p.total, 0);
  const response: AttentionResponse = {
    needsYou,
    waitingOnYou,
    mentions,
    failedJobs,
    channelGates,
    statusReports,
    offlineRunners,
    counts: {
      mentions: mentions.length,
      failedJobs: failedJobs.length,
      channelGates: channelGates.length,
      statusReports: statusReports.length,
      offlineRunners: offlineRunners.length,
    },
    total:
      needsYou.reduce((n, p) => n + p.total, 0) +
      mentions.length +
      failedJobs.length +
      channelGates.length +
      statusReports.length +
      offlineRunners.length,
  };

  return c.json(response);
});
