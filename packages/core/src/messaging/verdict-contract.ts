/**
 * Whether the contract version a verdict block names is one its issue's project recorded.
 *
 * `verdict-identity` decides a `contract:` value is written as one; this decides it names something.
 * A verdict judged against a version never recorded, or against another project's contract, would
 * read as earned on nothing, so the write door asks while the writer is there (ISS-60).
 */

import { db, type Tx } from '../db/client.js';
import type { MessageRefusal } from './contract.js';
import type { ForgeRecord } from './forge-record.js';
import { type ContractHolding, messageReads } from './reads.js';
import {
  CONTRACT_FIELD,
  type ContractIdentity,
  listed,
  type NamedIdentityRule,
  namedIdentityRefusals,
  parseContractIdentity,
} from './verdict-identity.js';

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 3',
  'verdict: pass',
  'contract: hop/postcare-api@1.1.0',
  'evidence: iss-1404-contract-test.log',
  '```',
].join('\n');

export type ContractLookup = (
  projectId: string,
  named: ContractIdentity,
) => Promise<ContractHolding>;

/** The provided contract read, through the caller's handle. */
export function contractLookup(executor?: Tx): ContractLookup {
  return (projectId, named) => messageReads().contractHolding(projectId, named, executor ?? db);
}

const CONTRACT_RULE: NamedIdentityRule<ContractIdentity, ContractHolding> = {
  rule: 'verdict-contract',
  shape:
    "a `contract:` identity names a contract of this issue's own project, as `<project slug>/<contract slug>@<version>`, and a version core recorded for it",
  example: EXAMPLE,
  field: CONTRACT_FIELD,
  parse: parseContractIdentity,
  why: (block, named, held) => {
    if (held.named) return null;
    const at = `criterion ${block.criterion} names contract \`${named.project}/${named.contract}\` at version \`${named.version}\``;
    if (held.projectSlug !== named.project) {
      return `${at}, which is project \`${named.project}\`'s contract, and this issue's project is \`${held.projectSlug}\` — a verdict is judged against a contract version of its own issue's project`;
    }
    return `${at}, and this project recorded no such version of it. The versions it recorded, newest first: ${listed(held.versions)}`;
  },
};

/** Everything a `verdict` record is refused for about the contract versions its blocks name. */
export function verdictContractRefusals(
  projectId: string,
  record: ForgeRecord | null,
  lookup: ContractLookup,
): Promise<MessageRefusal[]> {
  return namedIdentityRefusals(record, CONTRACT_RULE, (named) => lookup(projectId, named));
}
