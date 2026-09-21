import { isSentryEnabled, Sentry } from '../observability/sentry.js';
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
        // ISS-258 — surface orphan-cascade counts on the same breadcrumb so
        // the close event is not double-emitted just to carry this signal.
        cascadedJobIds: p.cascadedJobIds ?? [],
      },
    });
  });
}
