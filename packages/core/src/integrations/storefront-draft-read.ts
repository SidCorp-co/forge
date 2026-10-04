import { getIntegration } from './registry.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
} from './store.js';
import type { StorefrontDraftReading } from './types.js';

/** The draft a storefront binding's provider holds of one workflow now, or why it cannot be read. */
export async function readStorefrontDraft(args: {
  provider: string;
  binding: string;
  workflowId: string;
}): Promise<StorefrontDraftReading> {
  const { provider, binding, workflowId } = args;
  const pair = await findBindingWithConnectionById(binding);
  if (!pair) {
    return {
      kind: 'unreadable',
      detail: `the storefront source names binding \`${binding}\`, which core does not hold`,
    };
  }
  const read = getIntegration(provider)?.storefrontDraft;
  if (!read) {
    return {
      kind: 'unreadable',
      detail: `core has no draft reader for provider \`${provider}\`, so a ${provider} draft cannot be read back`,
    };
  }
  try {
    return await read({
      connectionId: pair.connection.id,
      config: effectiveConfig<Record<string, unknown>>(pair),
      readSecrets: () => decryptConnectionSecrets(pair.connection),
      workflowId,
    });
  } catch (err) {
    return { kind: 'unreadable', detail: `the ${provider} read failed: ${(err as Error).message}` };
  }
}
