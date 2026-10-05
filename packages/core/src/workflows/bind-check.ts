/**
 * The design-write door's half of requirement-to-delivery `impact`: a step that binds an element of a
 * contract no element index reads (asyncapi, protobuf, opaque) is refused at the workflows write, as
 * the pin refuses it at agree (`requirements/bindings.ts:bindingRefusals`), so a change to it could
 * never silently read as touching no screen.
 */

import { isElementIndexed } from '@forge/contracts/ecosystem';
import { inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { contractVersionReads } from '../lib/contract-versions.js';
import type { WorkflowRefusal } from './rules.js';
import { stepsOf, type WorkflowWrite } from './schema.js';

const bindsOf = (doc: WorkflowWrite) =>
  stepsOf(doc).flatMap((s, i) =>
    (s.node?.binds ?? []).map((b, j) => ({ step: s.id, at: `/steps/${i}/node/binds/${j}`, ...b })),
  );

/**
 * Each bind to a contract whose current type is not element-indexed, refused by name. `types` maps
 * `<provider>/<contract>` to that contract's current type; a contract with no recorded version is
 * not refused here, since its type is not known until it publishes one, and the pin reads it then.
 */
export function unindexedBindRefusals(
  doc: WorkflowWrite,
  types: ReadonlyMap<string, string>,
): WorkflowRefusal[] {
  return bindsOf(doc).flatMap((b) => {
    const contract = `${b.provider}/${b.slug}`;
    const type = types.get(contract);
    if (type === undefined || isElementIndexed(type)) return [];
    return [
      {
        code: 'REQUIREMENT_BINDING_NOT_INDEXED' as const,
        path: b.at,
        detail: `step \`${b.step}\` binds ${b.element} of ${contract}, ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type} contract; only an element-indexed contract (openapi, mcp-tools, json-schema, graphql) can be bound, so a change to it could never name the screens it reaches. Name it in the step's \`contracts\` instead, or publish the contract as an indexed type.`,
      },
    ];
  });
}

/** The current type of every contract the document binds, read as the pin reads it. */
export async function boundContractTypes(tx: Tx, doc: WorkflowWrite): Promise<Map<string, string>> {
  const binds = bindsOf(doc);
  if (binds.length === 0) return new Map();
  const providers = await tx
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.slug, [...new Set(binds.map((b) => b.provider))]));
  if (providers.length === 0) return new Map();
  const slugOf = new Map(providers.map((p) => [p.id, p.slug]));
  const current = await contractVersionReads().currentVersionsOf(
    tx,
    providers.map((p) => p.id),
  );
  return new Map(
    current.map((v) => [`${slugOf.get(v.providerProjectId)}/${v.contractSlug}`, v.contractType]),
  );
}

export async function bindRefusalsIn(tx: Tx, doc: WorkflowWrite): Promise<WorkflowRefusal[]> {
  return unindexedBindRefusals(doc, await boundContractTypes(tx, doc));
}
