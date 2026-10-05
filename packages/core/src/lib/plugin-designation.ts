import type { PluginRefusalCode } from '@forge/contracts/plugins';
import type { Refusal } from '@forge/contracts/refusal';
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
  })
  .strict();

export const pluginDesignationsPatchSchema = z.array(pluginDesignationSchema).max(20).nullable();

export type PluginDesignation = z.infer<typeof pluginDesignationSchema>;

interface ResolvedPluginDesignation extends PluginDesignation {
  /** Slugs of the bound projects that asked for this plugin — traceability for the operator. */
  projects: string[];
  /** Set when bound projects pinned different SHAs; the pin is then dropped rather than guessed. */
  pinnedRefConflict?: string[];
}

/** A stored list no write door would have accepted is refused by name, never read as no plugins. */
export function readPluginDesignations(
  agentConfig: unknown,
  slug: string,
):
  | { ok: true; designations: PluginDesignation[] }
  | { ok: false; refusal: Refusal & { code: PluginRefusalCode } } {
  const ac = (agentConfig as Record<string, unknown> | null) ?? {};
  const parsed = z.array(pluginDesignationSchema).safeParse(ac.plugins ?? []);
  if (parsed.success) return { ok: true, designations: parsed.data };
  const at = parsed.error.issues.map((i) => `plugins.${i.path.join('.')}: ${i.message}`).join('; ');
  return {
    ok: false,
    refusal: {
      code: 'PLUGIN_DESIGNATIONS_INVALID',
      path: '',
      detail: `project ${slug} stores agentConfig.plugins that no write door accepts (${at}). Rewrite the list with PATCH /api/projects/:id/plugins.`,
    },
  };
}

/**
 * Union the designations of every project a device serves, keyed by `marketplace::name`.
 *
 * A device holds ONE marketplace clone and ONE installed version, so differing `pinnedRef` SHAs
 * drop the pin and report the conflict, rather than silently picking one and reporting a state
 * that is true for only some of the projects.
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
          projects: [slug],
        });
        continue;
      }
      if (!existing.projects.includes(slug)) existing.projects.push(slug);

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
