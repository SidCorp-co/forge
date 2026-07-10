/**
 * ISS-526 — labelled Sentry targets resolution + rendering.
 *
 * A Sentry connection holds one host + one auth token but may map to SEVERAL
 * Sentry projects (backend / frontend / mobile). `targets[]` (jsonb on the
 * connection config) carries that labelled list. These helpers give the rest of
 * the codebase ONE place to read targets — handling the ISS-524 legacy shape
 * (single top-level `organizationSlug`/`projectSlug` pair) transparently so no
 * data migration is needed.
 */

import type { SentryConfig, SentryTarget } from './types.js';

/**
 * Resolve the labelled targets for a Sentry config:
 *  1. `config.targets[]` when present & non-empty (ISS-526);
 *  2. else the legacy single `(organizationSlug, projectSlug)` pair synthesized
 *     into one `'default'` target (ISS-524 back-compat — no migration);
 *  3. else `[]`.
 */
export function resolveSentryTargets(config: SentryConfig | null | undefined): SentryTarget[] {
  if (!config) return [];
  if (Array.isArray(config.targets) && config.targets.length > 0) {
    return config.targets;
  }
  if (config.organizationSlug || config.projectSlug) {
    const legacy: SentryTarget = { label: 'default' };
    if (config.organizationSlug) legacy.organizationSlug = config.organizationSlug;
    if (config.projectSlug) legacy.projectSlug = config.projectSlug;
    return [legacy];
  }
  return [];
}

/**
 * Render the targets as a compact indented block for the agent system prompt
 * (`## Project integrations`). One line per target:
 *   `  - <label>: org=<org> project=<project>[ env=<env>][ — <notes>]`
 * Returns `''` when there are no targets (caller omits the block entirely).
 */
export function renderSentryTargetsLine(targets: SentryTarget[]): string {
  if (targets.length === 0) return '';
  return targets
    .map((t) => {
      const scope: string[] = [];
      if (t.organizationSlug) scope.push(`org=${t.organizationSlug}`);
      if (t.projectSlug) scope.push(`project=${t.projectSlug}`);
      if (t.environment) scope.push(`env=${t.environment}`);
      const scopeStr = scope.length > 0 ? ` ${scope.join(' ')}` : '';
      const notesStr = t.notes ? ` — ${t.notes}` : '';
      return `  - ${t.label}:${scopeStr}${notesStr}`;
    })
    .join('\n');
}
