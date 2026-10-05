/**
 * Whether the workflow design revision a verdict block names is one its issue's project holds.
 *
 * `verdict-identity` decides a `design:` value is written as one; this decides it names something.
 * A verdict judged against a design that does not exist, at a revision never stored, or in another
 * project would read as earned on nothing, so the write door asks while the writer is there.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projectWorkflowDesigns, projectWorkflows } from '../db/schema-workflows.js';
import type { MessageRefusal } from './contract.js';
import type { ForgeRecord } from './forge-record.js';
import {
  DESIGN_FIELD,
  type DesignIdentity,
  listed,
  namedIdentityRefusals,
  parseDesignIdentity,
} from './verdict-identity.js';

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 2',
  'verdict: pass',
  'design: discharge-post-care rev 4',
  'evidence: iss1-r4-design-readback.json',
  '```',
].join('\n');

/** How many of a project's flows a refusal lists when the one named is not among them. */
const FLOWS_LISTED = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A workflow a design identity resolved to, and every revision of it that exists. */
interface FoundDesign {
  readonly id: string;
  readonly flow: string;
  readonly projectId: string;
  /** The current revision first, then each stored design revision, ascending, no repeats. */
  readonly revisions: readonly number[];
}

/** What a design identity resolved to: the workflow, or the flows the project does hold. */
type DesignLookupResult =
  | { readonly kind: 'found'; readonly design: FoundDesign }
  | { readonly kind: 'missing'; readonly flows: readonly string[] };

export type DesignLookup = (projectId: string, workflow: string) => Promise<DesignLookupResult>;

/** By id anywhere, so a design in another project is refused by name rather than as missing; by
 *  flow only within the project, the flow being unique per project and meaningless outside it. */
export function dbDesignLookup(executor?: Tx): DesignLookup {
  const handle = executor ?? db;
  return async (projectId, workflow) => {
    const columns = {
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      projectId: projectWorkflows.projectId,
      revision: projectWorkflows.revision,
    };
    const [byId] = UUID.test(workflow)
      ? await handle
          .select(columns)
          .from(projectWorkflows)
          .where(eq(projectWorkflows.id, workflow))
          .limit(1)
      : [];
    const [byFlow] = byId
      ? [byId]
      : await handle
          .select(columns)
          .from(projectWorkflows)
          .where(
            and(eq(projectWorkflows.projectId, projectId), eq(projectWorkflows.flow, workflow)),
          )
          .limit(1);
    if (!byFlow) {
      const flows = await handle
        .select({ flow: projectWorkflows.flow })
        .from(projectWorkflows)
        .where(eq(projectWorkflows.projectId, projectId))
        .orderBy(asc(projectWorkflows.flow))
        .limit(FLOWS_LISTED);
      return { kind: 'missing', flows: flows.map((row) => row.flow) };
    }
    const stored = await handle
      .select({ revision: projectWorkflowDesigns.revision })
      .from(projectWorkflowDesigns)
      .where(eq(projectWorkflowDesigns.workflowId, byFlow.id))
      .orderBy(asc(projectWorkflowDesigns.revision));
    const revisions = [
      byFlow.revision,
      ...stored.map((row) => row.revision).filter((n) => n !== byFlow.revision),
    ];
    return {
      kind: 'found',
      design: { id: byFlow.id, flow: byFlow.flow, projectId: byFlow.projectId, revisions },
    };
  };
}

/** Everything a `verdict` record is refused for about the designs its blocks name. */
export function verdictDesignRefusals(
  projectId: string,
  record: ForgeRecord | null,
  lookup: DesignLookup,
): Promise<MessageRefusal[]> {
  return namedIdentityRefusals(
    record,
    {
      rule: 'verdict-design',
      shape:
        "a `design:` identity names a workflow of this issue's own project, by its flow or its id, and a revision that workflow holds: its current revision or one put in front of its approver",
      example: EXAMPLE,
      field: DESIGN_FIELD,
      parse: parseDesignIdentity,
      why: (block, named: DesignIdentity, found: DesignLookupResult) => {
        const at = `criterion ${block.criterion} names design \`${named.workflow}\` rev ${named.revision}`;
        if (found.kind === 'missing') {
          return `${at}, and this issue's project holds no workflow with that flow or id. The flows it holds: ${listed(found.flows)}`;
        }
        const { design } = found;
        if (design.projectId !== projectId) {
          return `${at}, which is workflow \`${design.flow}\` of another project — a verdict is judged against a design of its own issue's project`;
        }
        if (design.revisions.includes(named.revision)) return null;
        return `${at}, and workflow \`${design.flow}\` holds no revision ${named.revision}. The revisions it holds: ${listed([...design.revisions].sort((a, b) => a - b))}`;
      },
    },
    (named) => lookup(projectId, named.workflow),
  );
}
