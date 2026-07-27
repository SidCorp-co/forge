// Server-designated Claude Code plugins (ISS-739 follow-up).
//
// A plugin is installed at DEVICE scope — one install serves every job the daemon dispatches
// (docs/architecture/skill-delivery-plugin-channel.md). Designation, however, is per PROJECT, so a
// device resolves the UNION of the designations of every project it is bound to. Per-project
// enable/disable is not expressible here: that lever is `enabledPlugins` in the repo's own
// .claude/settings.json, which Claude Code honours at project scope.
//
// Stored at `projects.agent_config.plugins` — an existing jsonb column, so no migration.

import { z } from 'zod';

export const pluginDesignationSchema = z
  .object({
    marketplace: z.string().trim().min(1).max(200),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'plugin name must be kebab-case'),
    pinnedRef: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,40}$/, 'pinnedRef must be a git commit SHA')
      .nullable()
      .optional(),
    autoUpdate: z.boolean().optional(),
  })
  .strict();

export const pluginDesignationsPatchSchema = z.array(pluginDesignationSchema).max(20).nullable();

export type PluginDesignation = z.infer<typeof pluginDesignationSchema>;

export interface ResolvedPluginDesignation extends PluginDesignation {
  /** Slugs of the bound projects that asked for this plugin — traceability for the operator. */
  projects: string[];
  /** Set when bound projects pinned different SHAs; the pin is then dropped rather than guessed. */
  pinnedRefConflict?: string[];
}

export function readPluginDesignations(agentConfig: unknown): PluginDesignation[] {
  const ac = (agentConfig as Record<string, unknown> | null) ?? {};
  const parsed = z.array(pluginDesignationSchema).safeParse(ac.plugins ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * Wholesale replace, deliberately: a list has no stable per-entry key a caller could patch by, and
 * a silent nested merge is exactly how sibling entries get clobbered. `null` clears the list.
 */
export function mergePluginDesignations(
  patch: PluginDesignation[] | null,
): PluginDesignation[] | null {
  if (patch === null) return null;
  const seen = new Set<string>();
  const out: PluginDesignation[] = [];
  for (const d of patch) {
    const key = `${d.marketplace}::${d.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Union the designations of every project a device serves, keyed by `marketplace::name`.
 *
 * Conflict rules, both biased toward the safer outcome because a device holds ONE marketplace
 * clone and ONE installed version:
 * - `autoUpdate` — false wins. One project asking to stay pinned outranks another asking to float.
 * - `pinnedRef`  — differing SHAs drop the pin and report the conflict, rather than silently
 *   picking one and reporting a state that is true for only some of the projects.
 */
export function unionPluginDesignations(
  perProject: Array<{ slug: string; designations: PluginDesignation[] }>,
): ResolvedPluginDesignation[] {
  const byKey = new Map<string, ResolvedPluginDesignation>();

  for (const { slug, designations } of perProject) {
    for (const d of designations) {
      const key = `${d.marketplace}::${d.name}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          marketplace: d.marketplace,
          name: d.name,
          pinnedRef: d.pinnedRef ?? null,
          autoUpdate: d.autoUpdate ?? true,
          projects: [slug],
        });
        continue;
      }
      if (!existing.projects.includes(slug)) existing.projects.push(slug);
      if (d.autoUpdate === false) existing.autoUpdate = false;

      const incoming = d.pinnedRef ?? null;
      if (incoming && existing.pinnedRef && incoming !== existing.pinnedRef) {
        const conflict = new Set(existing.pinnedRefConflict ?? [existing.pinnedRef]);
        conflict.add(incoming);
        existing.pinnedRefConflict = [...conflict].sort();
        existing.pinnedRef = null;
      } else if (incoming && !existing.pinnedRef && !existing.pinnedRefConflict) {
        existing.pinnedRef = incoming;
      }
    }
  }

  for (const entry of byKey.values()) entry.projects.sort();
  return [...byKey.values()].sort(
    (a, b) => a.marketplace.localeCompare(b.marketplace) || a.name.localeCompare(b.name),
  );
}
