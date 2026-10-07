import { getIntegration } from './registry.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
} from './store.js';
import type { StorefrontDraftReading } from './types.js';

/**
 * The draft a storefront binding's provider holds now of each workflow named, or why it cannot be
 * read: one binding lookup and one provider read for all of them, so a reader holding verdicts on
 * thirty drafts asks the provider once, not thirty times.
 */
export async function readStorefrontDrafts(args: {
  provider: string;
  binding: string;
  workflowIds: readonly string[];
}): Promise<Map<string, StorefrontDraftReading>> {
  const { provider, binding } = args;
  const workflowIds = [...new Set(args.workflowIds)];
  const every = (reading: StorefrontDraftReading) =>
    new Map(workflowIds.map((id) => [id, reading]));
  if (workflowIds.length === 0) return new Map();
  const pair = await findBindingWithConnectionById(binding);
  if (!pair) {
    return every({
      kind: 'unreadable',
      detail: `the storefront source names binding \`${binding}\`, which core does not hold`,
    });
  }
  const read = getIntegration(provider)?.storefrontDrafts;
  if (!read) {
    return every({
      kind: 'unreadable',
      detail: `core has no draft reader for provider \`${provider}\`, so a ${provider} draft cannot be read back`,
    });
  }
  let readings: Map<string, StorefrontDraftReading>;
  try {
    readings = await read({
      connectionId: pair.connection.id,
      config: effectiveConfig<Record<string, unknown>>(pair),
      readSecrets: () => decryptConnectionSecrets(pair.connection),
      workflowIds,
    });
  } catch (err) {
    return every({
      kind: 'unreadable',
      detail: `the ${provider} read failed: ${(err as Error).message}`,
    });
  }
  return new Map(
    workflowIds.map((id): [string, StorefrontDraftReading] => [
      id,
      readings.get(id) ?? {
        kind: 'unreadable',
        detail: `the ${provider} draft reader answered no reading of workflow \`${id}\``,
      },
    ]),
  );
}
