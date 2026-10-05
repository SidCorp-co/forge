/**
 * Screen bindings (requirement-to-delivery `pins` and `impact`): the contract elements each screen of
 * a pinned design binds (`node.binds`), read from the design revision the baseline pins, so a pin
 * names them with the design and an impact can list the screens a changed element reaches.
 */

import { isElementIndexed } from '@forge/contracts/ecosystem';
import type { RequirementScreenBinding } from '@forge/contracts/requirements';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { projectWorkflowDesigns } from '../db/schema-workflows.js';
import { contractVersionReads } from '../lib/contract-versions.js';
import { RefusalError } from '../lib/refusal.js';
import type { RequirementRefusal } from './rules.js';

export interface PinnedDesign {
  workflowId: string;
  flow: string;
  designRevision: number;
}

interface BindStep {
  id?: unknown;
  node?: { binds?: { provider?: unknown; slug?: unknown; element?: unknown }[] };
}

/** The bindings of one design document, in step order. */
export function bindingsInDocument(
  design: PinnedDesign,
  document: unknown,
): Omit<RequirementScreenBinding, 'contractType' | 'pinnedVersion' | 'brokenBy'>[] {
  const steps = (document as { steps?: BindStep[] } | null)?.steps ?? [];
  return steps.flatMap((s) =>
    (s.node?.binds ?? []).map((b) => ({
      workflowId: design.workflowId,
      flow: design.flow,
      designRevision: design.designRevision,
      step: String(s.id),
      contract: `${String(b.provider)}/${String(b.slug)}`,
      element: String(b.element),
    })),
  );
}

export interface PinnedContract {
  providerProjectId: string;
  contractSlug: string;
  contractVersion: string;
}

interface VersionFacts {
  providerProjectId: string;
  contractSlug: string;
  version: string;
  approval: string;
  elements: string[] | null;
  breakingElements: string[];
}

/** Whether a change named at `changed` reaches the element a screen binds (itself or beneath it). */
export const reaches = (bound: string, changed: string) =>
  changed === bound || [' ', '/', '.', '#'].some((sep) => changed.startsWith(`${bound}${sep}`));

/**
 * The newest approved version past `pinned` that removed the bound element (it was in the pinned
 * version's elements and is not in that one's) or names a breaking change reaching it; versions newest first.
 */
export function brokenByOf(
  element: string,
  pinned: string,
  versions: readonly VersionFacts[],
): string | null {
  const at = versions.findIndex((v) => v.version === pinned);
  if (at < 0) return null;
  const had = versions[at]?.elements?.includes(element) ?? false;
  for (const v of versions.slice(0, at)) {
    if (v.approval !== 'approved') continue;
    const removed = had && v.elements !== null && !v.elements.includes(element);
    if (removed || v.breakingElements.some((c) => reaches(element, c))) return v.version;
  }
  return null;
}

/** Each binding to a contract whose type is not element-indexed, refused by name. */
export function bindingRefusals(
  bindings: readonly RequirementScreenBinding[],
): RequirementRefusal[] {
  return bindings
    .filter((b) => b.contractType !== null && !isElementIndexed(b.contractType))
    .map((b) => ({
      code: 'REQUIREMENT_BINDING_NOT_INDEXED' as const,
      path: '/designs',
      detail: `design \`${b.flow}\` r${b.designRevision} step \`${b.step}\` binds ${b.element} of ${b.contract}, a ${b.contractType} contract; only an element-indexed contract (openapi, mcp-tools, json-schema, graphql) can be bound, so a change to it could never name the screens it reaches. Bind the step through \`contracts\` instead, or publish the contract as an indexed type.`,
    }));
}

/** The bindings inside `designs` at their pinned revisions, each with its contract's current type. */
export async function screenBindingsOf(
  executor: Tx | typeof db,
  designs: readonly PinnedDesign[],
  contractPins: readonly PinnedContract[] = [],
): Promise<RequirementScreenBinding[]> {
  if (designs.length === 0) return [];
  const docs = await executor
    .select({
      workflowId: projectWorkflowDesigns.workflowId,
      revision: projectWorkflowDesigns.revision,
      document: projectWorkflowDesigns.document,
    })
    .from(projectWorkflowDesigns)
    .where(
      or(
        ...designs.map((d) =>
          and(
            eq(projectWorkflowDesigns.workflowId, d.workflowId),
            eq(projectWorkflowDesigns.revision, d.designRevision),
          ),
        ),
      ),
    );
  const raw = designs.flatMap((d) =>
    bindingsInDocument(
      d,
      docs.find((x) => x.workflowId === d.workflowId && x.revision === d.designRevision)
        ?.document ?? null,
    ),
  );
  if (raw.length === 0) return [];
  const slugs = [...new Set(raw.map((b) => b.contract.split('/')[0] as string))];
  const providers = await executor
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.slug, slugs));
  const reads = contractVersionReads();
  const ids = providers.map((p) => p.id);
  const [current, versions] = await Promise.all([
    reads.currentVersionsOf(executor as Tx, ids),
    reads.versionsOf(executor as Tx, ids),
  ]);
  return raw.map((b) => {
    const [slug, contractSlug] = b.contract.split('/');
    const id = providers.find((p) => p.slug === slug)?.id;
    const mine = (v: { providerProjectId: string; contractSlug: string }) =>
      v.providerProjectId === id && v.contractSlug === contractSlug;
    const pinnedVersion = contractPins.find(mine)?.contractVersion ?? null;
    return {
      ...b,
      contractType: current.find(mine)?.contractType ?? null,
      pinnedVersion,
      brokenBy: pinnedVersion ? brokenByOf(b.element, pinnedVersion, versions.filter(mine)) : null,
    };
  });
}

/** A pin refuses a design that binds a contract no element index can read (`impact`). */
export async function refuseUnindexedBindings(
  tx: Tx,
  designs: readonly PinnedDesign[],
): Promise<void> {
  const refusals = bindingRefusals(await screenBindingsOf(tx, designs));
  if (refusals.length) throw new RefusalError(refusals, 'REQUIREMENT_REFUSED');
}
