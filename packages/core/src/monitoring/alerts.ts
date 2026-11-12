/**
 * Alertmanager's webhook, turned into feedback (ISS-1225). Each firing alert files ONE item on the
 * project its own `forge_project` label names, through the feedback intake's signal path
 * (`feedback/signal-filing.ts`), seen on the `monitoring` screen and joined by the alert's
 * fingerprint: a repeat of the same alert joins that item as an occurrence, and its resolution is
 * recorded on it. The project's own agent files it, so it reads as Forge's and never a person's, and
 * the filing's `feedback.filed` event wakes the project's master to triage it.
 */

import {
  MONITORING_FEEDBACK_SCREEN,
  MONITORING_PROJECT_LABEL,
  monitoringSignalKey,
} from '@forge/contracts/monitoring';
import type { Refusal } from '@forge/contracts/refusal';
import { z } from 'zod';
import { resolveProjectHandle } from '../conversations/index.js';
import { db } from '../db/client.js';
import { fileSignalFeedback, joinSignalFeedback } from '../feedback/index.js';

const TITLE_CAP = 200;

const alertSchema = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{1,64}$/),
});

/** Alertmanager's webhook body, version 4: only the fields read here are checked. */
export const alertsWebhookSchema = z.object({
  version: z.string().optional(),
  alerts: z.array(alertSchema).max(500),
});
export const ALERTS_WEBHOOK_SHAPE =
  "Alertmanager's webhook body: { version: '4', alerts: [{ status: firing | resolved, labels, annotations?, startsAt?, endsAt?, generatorURL?, fingerprint }] }";

type Alert = z.infer<typeof alertSchema>;

export interface AlertOutcome {
  fingerprint: string;
  project: string | null;
  /** The item filed or joined; null where a resolution found no open item to record on. */
  feedback: string | null;
  act: 'filed' | 'joined' | 'resolved' | 'nothing_open';
}

const SEVERITIES = { low: 'low', medium: 'medium', high: 'high' } as const;

function bodyOf(alert: Alert): string {
  const labels = Object.entries(alert.labels)
    .filter(([name]) => !name.startsWith('__'))
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');
  return [
    alert.annotations?.summary ?? '',
    `Firing since ${alert.startsAt ?? 'an unreported time'}.`,
    labels,
    alert.generatorURL ? `Expression: ${alert.generatorURL}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}

async function fileOne(alert: Alert, slug: string, projectId: string): Promise<AlertOutcome> {
  const agent = await db.transaction((tx) => resolveProjectHandle(tx, projectId));
  const actor = { userId: agent.userId, agency: 'agent' as const };
  const signalKey = monitoringSignalKey(alert.fingerprint);
  const source = { projectId, issueId: null, runId: null, clientVersion: null };
  const base = { fingerprint: alert.fingerprint, project: slug };
  if (alert.status === 'resolved') {
    const joined = await joinSignalFeedback({
      projectId,
      actor,
      signalKey,
      source,
      said: `Resolved at ${alert.endsAt ?? new Date().toISOString()}.`,
    });
    return { ...base, feedback: joined?.key ?? null, act: joined ? 'resolved' : 'nothing_open' };
  }
  const name = alert.labels.alertname ?? 'alert';
  const filed = await fileSignalFeedback({
    projectId,
    actor,
    request: {
      kind: 'bug',
      title: `${name} firing on ${slug}`.slice(0, TITLE_CAP),
      body: bodyOf(alert),
      severity: SEVERITIES[alert.labels.severity as keyof typeof SEVERITIES] ?? 'medium',
      screen: MONITORING_FEEDBACK_SCREEN,
    },
    signalKey,
    source,
    said: `Firing since ${alert.startsAt ?? 'an unreported time'}.`,
  });
  if (!filed.ok) {
    throw new Error(
      `monitoring: feedback refused alert ${alert.fingerprint}: ${filed.refusals.map((r) => r.code).join(', ')}`,
    );
  }
  return { ...base, feedback: filed.key, act: filed.created ? 'filed' : 'joined' };
}

/**
 * Every alert of one delivery, each on the project its own label names among those bound to the
 * connection that posted it. An alert naming any other files nothing and is refused by name; the
 * others are filed all the same.
 */
export async function receiveAlerts(
  alerts: readonly Alert[],
  /** The projects bound to the connection that posted: an alert files on one of these or nowhere. */
  bound: readonly { projectId: string; slug: string }[],
): Promise<{ outcomes: AlertOutcome[]; refusals: Refusal[] }> {
  const bySlug = new Map(bound.map((p) => [p.slug, p.projectId]));
  const outcomes: AlertOutcome[] = [];
  const refusals: Refusal[] = [];
  for (const [i, alert] of alerts.entries()) {
    const slug = alert.labels[MONITORING_PROJECT_LABEL];
    const projectId = slug ? bySlug.get(slug) : undefined;
    if (!slug || !projectId) {
      refusals.push({
        code: 'MONITORING_ALERT_PROJECT_UNKNOWN',
        path: `/alerts/${i}/labels/${MONITORING_PROJECT_LABEL}`,
        detail: `alert ${alert.fingerprint} names ${slug ? `project \`${slug}\`, which is not bound to this connection` : `no ${MONITORING_PROJECT_LABEL} label`}; nothing was filed for it`,
      });
      continue;
    }
    outcomes.push(await fileOne(alert, slug, projectId));
  }
  return { outcomes, refusals };
}
