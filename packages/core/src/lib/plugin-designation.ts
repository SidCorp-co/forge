import type { PluginPin, PluginRefusalCode } from '@forge/contracts/plugins';
import type { Refusal } from '@forge/contracts/refusal';
import { z } from 'zod';
import { RefusalError } from './refusal.js';

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
  /**
   * Set when bound projects pin this plugin's marketplace at different SHAs; the pin is then
   * dropped rather than guessed. Every plugin of that marketplace carries it: the box holds one clone.
   */
  pinnedRefConflict?: string[];
}

/** One project's designations, as a box serving it reads them. */
export interface ProjectDesignations {
  slug: string;
  designations: PluginDesignation[];
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
 * Each project's stored list, refusing the whole box by name where one is unreadable: a box that
 * cannot know one project's pins cannot say whether they conflict, so neither read answers as if it could.
 */
export function readBoxDesignations(
  rows: ReadonlyArray<{ slug: string; agentConfig: unknown }>,
): ProjectDesignations[] {
  return rows.map((r) => {
    const read = readPluginDesignations(r.agentConfig, r.slug);
    if (!read.ok) throw new RefusalError([read.refusal], 'PLUGIN_DESIGNATIONS_INVALID');
    return { slug: r.slug, designations: read.designations };
  });
}

/**
 * The pins of one box that it cannot all honour, per marketplace: a box holds ONE clone of each
 * marketplace (`runner-workspace/src/plugin_sync.rs:ensure_plugins`), so two different SHAs pinned
 * into one marketplace conflict whether they pin one plugin or two of it. Unpinned designations
 * pin nothing and are left out.
 */
export function boxPinConflicts(
  perProject: readonly ProjectDesignations[],
): Map<string, PluginPin[]> {
  const byMarketplace = new Map<string, PluginPin[]>();
  for (const { slug, designations } of perProject) {
    for (const d of designations) {
      if (!d.pinnedRef) continue;
      const pins = byMarketplace.get(d.marketplace) ?? [];
      if (!pins.some((p) => p.project === slug && p.name === d.name && p.ref === d.pinnedRef)) {
        pins.push({ project: slug, name: d.name, ref: d.pinnedRef });
      }
      byMarketplace.set(d.marketplace, pins);
    }
  }
  const conflicts = new Map<string, PluginPin[]>();
  for (const [marketplace, pins] of byMarketplace) {
    if (new Set(pins.map((p) => p.ref)).size < 2) continue;
    conflicts.set(
      marketplace,
      pins.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name)),
    );
  }
  return conflicts;
}

/**
 * Union the designations of every project a device serves, keyed by `marketplace::name`.
 *
 * A marketplace its projects pin at different SHAs (`boxPinConflicts`) drops the pin of every plugin
 * in it and reports the conflict, rather than silently picking one and reporting a state that is
 * true for only some of the projects.
 */
export function unionPluginDesignations(
  perProject: readonly ProjectDesignations[],
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
      if (d.pinnedRef && !existing.pinnedRef) existing.pinnedRef = d.pinnedRef;
    }
  }

  const conflicts = boxPinConflicts(perProject);
  for (const entry of byKey.values()) {
    entry.projects.sort();
    const pins = conflicts.get(entry.marketplace);
    if (!pins) continue;
    entry.pinnedRef = null;
    entry.pinnedRefConflict = [...new Set(pins.map((p) => p.ref))].sort();
  }
  return [...byKey.values()].sort(
    (a, b) => a.marketplace.localeCompare(b.marketplace) || a.name.localeCompare(b.name),
  );
}
