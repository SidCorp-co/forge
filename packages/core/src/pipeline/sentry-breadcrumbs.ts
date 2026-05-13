/**
 * ISS-104 — attach a Sentry breadcrumb to every `pipelineRunStatusChanged`
 * hook event. Breadcrumbs are global per Node process and ride along with
 * the next captured event in the same isolation scope, so a slow-pipeline
 * error captured downstream surfaces the run's status history in the
 * Sentry UI without any explicit `captureException` plumbing here.
 *
 * Payload is IDs + status strings only — no titles, descriptions, or other
 * PII surfaces here.
 */

import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import type { HooksBus } from './hooks.js';

export function registerPipelineSentryBreadcrumbs(bus: HooksBus): void {
  bus.on('pipelineRunStatusChanged', (p) => {
    if (!isSentryEnabled()) return;
    Sentry.addBreadcrumb({
      category: 'pipeline_run.status_changed',
      level: 'info',
      message: `${p.fromStatus ?? 'null'} -> ${p.toStatus}`,
      data: {
        runId: p.runId,
        issueId: p.issueId,
        projectId: p.projectId,
        kind: p.kind,
        fromStatus: p.fromStatus,
        toStatus: p.toStatus,
        currentStep: p.currentStep,
      },
    });
  });
}
