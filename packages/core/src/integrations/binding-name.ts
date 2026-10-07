import { logger } from '../lib/logger.js';
import { getIntegration, listIntegrations } from './registry.js';
import type { ReportedIdentityBinding } from './types.js';

/** What a binding offers to be told apart by, one project's bindings at a time. */
export interface NameableBinding {
  id: string;
  provider: string;
  role: string;
  /** The project-document environment that deploys through it; null where none names it. */
  environment: string | null;
  /** The binding's own label; empty where it has none. */
  label: string;
  config: Record<string, unknown>;
}

function roleWord(role: string): string {
  if (role === 'service') return 'Service';
  if (role === 'source') return 'Source';
  return 'Deploy';
}

function identityOf(
  row: NameableBinding,
  reported: ReadonlyMap<string, string> | undefined,
): string | null {
  return (
    reported?.get(row.id) ??
    getIntegration(row.provider)?.presentation?.bindingIdentity?.(row.config) ??
    null
  );
}

function join(...parts: Array<string | null>): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return kept.length > 0 ? kept.join(' · ') : null;
}

function collisions(names: ReadonlyMap<string, string | null>): Set<string> {
  const seen = new Map<string, string[]>();
  for (const [id, name] of names) {
    const key = name ?? '';
    seen.set(key, [...(seen.get(key) ?? []), id]);
  }
  return new Set(
    [...seen.entries()].flatMap(([key, ids]) => (key === '' || ids.length > 1 ? ids : [])),
  );
}

/**
 * The text that tells each binding apart from the others of its provider and role on one project.
 *
 * A binding alone in its role reads as its environment or label, else the role itself. Two sharing a
 * role cannot be told apart by it, so each reads as its environment or label, and one still unnamed
 * or colliding takes what its provider says it points at: the name the provider reports for it (a
 * Coolify application's own name, `reported`), else what its config holds, and failing both its id.
 * No two bindings of a provider and role come back with the same text.
 */
export function bindingNames(
  rows: readonly NameableBinding[],
  reported?: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, NameableBinding[]>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.role}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const own = (row: NameableBinding) => row.environment ?? (row.label || null);
    if (group.length === 1) {
      const [row] = group as [NameableBinding];
      out.set(row.id, own(row) ?? roleWord(row.role));
      continue;
    }
    const names = new Map(group.map((row) => [row.id, own(row)] as const));
    for (const id of collisions(names)) {
      const row = group.find((r) => r.id === id) as NameableBinding;
      names.set(id, join(own(row), identityOf(row, reported)));
    }
    for (const id of collisions(names)) {
      names.set(id, join(names.get(id) ?? null, `binding ${id.slice(0, 8)}`));
    }
    for (const [id, name] of names) out.set(id, name ?? roleWord(group[0]?.role ?? 'deploy'));
  }
  return out;
}

/** One binding with the provider that serves it, as `reportedBindingIdentities` reads it. */
export interface ReportableBinding extends ReportedIdentityBinding {
  provider: string;
}

/**
 * What each provider that can be asked reports for its bindings, one answer per binding. A provider
 * that fails to answer is logged and leaves its bindings to their config's identity.
 */
export async function reportedBindingIdentities(
  bindings: readonly ReportableBinding[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    listIntegrations().map(async (decl) => {
      const ask = decl.presentation?.reportedIdentities;
      const own = bindings.filter((b) => b.provider === decl.provider);
      if (!ask || own.length === 0) return;
      try {
        for (const [id, name] of await ask(own)) out.set(id, name);
      } catch (err) {
        logger.warn(
          { provider: decl.provider, err: err instanceof Error ? err.message : String(err) },
          'a provider could not report what its bindings point at; their config names them',
        );
      }
    }),
  );
  return out;
}
