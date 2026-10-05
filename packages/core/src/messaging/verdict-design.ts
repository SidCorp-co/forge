/**
 * Whether the workflow design revision a verdict block names is one its issue's project holds.
 *
 * `verdict-identity` decides a `design:` value is written as one; this decides it names something.
 * A verdict judged against a design that does not exist, at a revision never stored, or in another
 * project would read as earned on nothing, so the write door asks while the writer is there.
 */

import { db, type Tx } from '../db/client.js';
import type { MessageRefusal } from './contract.js';
import type { ForgeRecord } from './forge-record.js';
import { type DesignLookupResult, messageReads } from './reads.js';
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

export type DesignLookup = (projectId: string, workflow: string) => Promise<DesignLookupResult>;

/** The provided workflow read, through the caller's handle. */
export function designLookup(executor?: Tx): DesignLookup {
  return (projectId, workflow) =>
    messageReads().workflowDesign(projectId, workflow, executor ?? db);
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
