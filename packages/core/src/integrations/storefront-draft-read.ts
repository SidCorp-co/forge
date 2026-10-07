import { getIntegration } from './registry.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
} from './store.js';
import type {
  IntegrationDeclaration,
  StorefrontDraftReading,
  StorefrontPublishedReading,
  StorefrontTargetArgs,
} from './types.js';

type Unreadable = { readonly kind: 'unreadable'; readonly detail: string };

type PerWorkflowRead<R> = (
  args: StorefrontTargetArgs & { workflowIds: readonly string[] },
) => Promise<Map<string, R>>;

/**
 * One binding lookup and one provider read for every workflow named, each answered, never absent:
 * a reader holding verdicts on thirty workflows asks the provider once, not thirty times.
 */
async function readPerWorkflow<R>(
  args: { provider: string; binding: string; workflowIds: readonly string[] },
  what: string,
  hook: (decl: IntegrationDeclaration) => PerWorkflowRead<R> | undefined,
): Promise<Map<string, R | Unreadable>> {
  const { provider, binding } = args;
  const workflowIds = [...new Set(args.workflowIds)];
  const every = (detail: string) =>
    new Map<string, R | Unreadable>(
      workflowIds.map((id) => [id, { kind: 'unreadable', detail } as Unreadable]),
    );
  if (workflowIds.length === 0) return new Map();
  const pair = await findBindingWithConnectionById(binding);
  if (!pair) {
    const whose = what === 'draft' ? 'the storefront source' : 'production';
    return every(`${whose} names binding \`${binding}\`, which core does not hold`);
  }
  const decl = getIntegration(provider);
  const read = decl ? hook(decl) : undefined;
  if (!read) {
    return every(
      `core has no ${what} reader for provider \`${provider}\`, so a ${provider} ${what} graph cannot be read back`,
    );
  }
  let readings: Map<string, R>;
  try {
    readings = await read({
      connectionId: pair.connection.id,
      config: effectiveConfig<Record<string, unknown>>(pair),
      readSecrets: () => decryptConnectionSecrets(pair.connection),
      workflowIds,
    });
  } catch (err) {
    return every(`the ${provider} read failed: ${(err as Error).message}`);
  }
  return new Map(
    workflowIds.map((id): [string, R | Unreadable] => [
      id,
      readings.get(id) ?? {
        kind: 'unreadable',
        detail: `the ${provider} ${what} reader answered no reading of workflow \`${id}\``,
      },
    ]),
  );
}

/** The draft a storefront binding's provider holds now of each workflow named, or why it cannot be read. */
export async function readStorefrontDrafts(args: {
  provider: string;
  binding: string;
  workflowIds: readonly string[];
}): Promise<Map<string, StorefrontDraftReading>> {
  return readPerWorkflow(args, 'draft', (d) => d.storefrontDrafts);
}

/** What a storefront binding's provider publishes now of each workflow named, or why it cannot be read. */
export async function readStorefrontPublished(args: {
  provider: string;
  binding: string;
  workflowIds: readonly string[];
}): Promise<Map<string, StorefrontPublishedReading>> {
  return readPerWorkflow(args, 'published', (d) => d.storefrontPublished);
}
