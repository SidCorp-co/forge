/**
 * Whether the contract version a verdict block names is one its issue's project recorded.
 *
 * `verdict-identity` decides a `contract:` value is written as one; this decides it names something.
 * A verdict judged against a version never recorded, or against another project's contract, would
 * read as earned on nothing, so the write door asks while the writer is there (ISS-60).
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { contractVersions } from '../db/schema-ecosystem.js';
import type { MessageRefusal } from './contract.js';
import type { ForgeRecord } from './forge-record.js';
import {
  CONTRACT_FIELD,
  type ContractIdentity,
  type CriterionBlock,
  criterionBlocksIn,
  parseContractIdentity,
} from './verdict-identity.js';

const RULE = 'verdict-contract';

const SHAPE =
  "a `contract:` identity names a contract of this issue's own project, as `<project slug>/<contract slug>@<version>`, and a version core recorded for it";

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 3',
  'verdict: pass',
  'contract: hop/postcare-api@1.1.0',
  'evidence: iss-1404-contract-test.log',
  '```',
].join('\n');

/** How many recorded versions a refusal lists when the one named is not among them. */
const VERSIONS_LISTED = 10;

/** What the issue's project holds for a named contract: its slug, and the versions it recorded. */
export interface ContractHolding {
  readonly projectSlug: string;
  /** Newest first, at most `VERSIONS_LISTED` beyond the one named. */
  readonly versions: readonly string[];
  readonly named: boolean;
}

export type ContractLookup = (
  projectId: string,
  named: ContractIdentity,
) => Promise<ContractHolding>;

export function dbContractLookup(executor?: Tx): ContractLookup {
  const handle = executor ?? db;
  return async (projectId, named) => {
    const [project] = await handle
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const projectSlug = project?.slug ?? '';
    if (projectSlug !== named.project) return { projectSlug, versions: [], named: false };
    const rows = await handle
      .select({ version: contractVersions.version })
      .from(contractVersions)
      .where(
        and(
          eq(contractVersions.providerProjectId, projectId),
          eq(contractVersions.contractSlug, named.contract),
        ),
      )
      .orderBy(desc(contractVersions.recordedAt));
    const versions = rows.map((r) => r.version);
    return {
      projectSlug,
      versions: versions.slice(0, VERSIONS_LISTED),
      named: versions.includes(named.version),
    };
  };
}

function refusal(why: string, quote: string): MessageRefusal {
  return { rule: RULE, why, quote, shape: SHAPE, example: EXAMPLE };
}

/** The refusal one block earns for the contract version it names, or null where it was recorded here. */
export function contractRefusal(
  block: CriterionBlock,
  named: ContractIdentity,
  held: ContractHolding,
): MessageRefusal | null {
  if (held.named) return null;
  const quote = `${CONTRACT_FIELD}: ${block.contract ?? ''}`;
  const at = `criterion ${block.criterion} names contract \`${named.project}/${named.contract}\` at version \`${named.version}\``;
  if (held.projectSlug !== named.project) {
    return refusal(
      `${at}, which is project \`${named.project}\`'s contract, and this issue's project is \`${held.projectSlug}\` — a verdict is judged against a contract version of its own issue's project`,
      quote,
    );
  }
  const listed =
    held.versions.length === 0 ? 'none' : held.versions.map((v) => `\`${v}\``).join(', ');
  return refusal(
    `${at}, and this project recorded no such version of it. The versions it recorded, newest first: ${listed}`,
    quote,
  );
}

/** Everything a `verdict` record is refused for about the contract versions its blocks name. */
export async function verdictContractRefusals(
  projectId: string,
  record: ForgeRecord | null,
  lookup: ContractLookup,
): Promise<MessageRefusal[]> {
  const out: MessageRefusal[] = [];
  for (const block of criterionBlocksIn(record)) {
    if (block.verdict === null || block.contract === null) continue;
    const named = parseContractIdentity(block.contract);
    if (!named) continue;
    const refused = contractRefusal(block, named, await lookup(projectId, named));
    if (refused) out.push(refused);
  }
  return out;
}
