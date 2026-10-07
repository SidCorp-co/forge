import { getIntegration } from './registry.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
} from './store.js';
import type {
  IntegrationDeclaration,
  StorefrontDraftReading,
  StorefrontServed,
  StorefrontServedAsk,
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
    return every(`the storefront source names binding \`${binding}\`, which core does not hold`);
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

const unique = (ids: readonly string[]) => [...new Set(ids)];

/** Every asked key answered `unreadable` with one reason: the read that would answer them did not happen. */
export function servedUnreadable(ask: StorefrontServedAsk, detail: string): StorefrontServed {
  const every = <R>(ids: readonly string[]) =>
    new Map<string, R>(unique(ids).map((id) => [id, { kind: 'unreadable', detail } as R]));
  return {
    workflows: every(ask.workflowIds),
    routes: every(ask.routeIds),
    pages: every(ask.pageIds),
    theme: ask.theme ? { kind: 'unreadable', detail } : null,
    settings: every(ask.settingKeys),
  };
}

/** The reader's answer with every asked key present: one it left out reads as not answered. */
function answeredWhole(
  provider: string,
  ask: StorefrontServedAsk,
  got: StorefrontServed,
): StorefrontServed {
  const fill = <R>(ids: readonly string[], held: ReadonlyMap<string, R>, what: string) =>
    new Map<string, R>(
      unique(ids).map((id) => [
        id,
        held.get(id) ??
          ({
            kind: 'unreadable',
            detail: `the ${provider} published reader answered no reading of ${what} \`${id}\``,
          } as R),
      ]),
    );
  return {
    workflows: fill(ask.workflowIds, got.workflows, 'workflow'),
    routes: fill(ask.routeIds, got.routes, 'route'),
    pages: fill(ask.pageIds, got.pages, 'page'),
    theme: ask.theme
      ? (got.theme ?? {
          kind: 'unreadable',
          detail: `the ${provider} published reader answered no reading of the served theme`,
        })
      : null,
    settings: fill(ask.settingKeys, got.settings, 'setting'),
  };
}

/**
 * What a storefront binding's provider serves now of every workflow, route, page, theme and setting
 * asked, or why each cannot be read: one binding lookup, one provider read per kind.
 */
export async function readStorefrontPublished(args: {
  provider: string;
  binding: string;
  ask: StorefrontServedAsk;
}): Promise<StorefrontServed> {
  const { provider, binding, ask } = args;
  const pair = await findBindingWithConnectionById(binding);
  if (!pair) {
    return servedUnreadable(
      ask,
      `production names binding \`${binding}\`, which core does not hold`,
    );
  }
  const read = getIntegration(provider)?.storefrontPublished;
  if (!read) {
    return servedUnreadable(
      ask,
      `core has no published reader for provider \`${provider}\`, so what ${provider} serves cannot be read back`,
    );
  }
  try {
    const got = await read({
      connectionId: pair.connection.id,
      config: effectiveConfig<Record<string, unknown>>(pair),
      readSecrets: () => decryptConnectionSecrets(pair.connection),
      ask,
    });
    return answeredWhole(provider, ask, got);
  } catch (err) {
    return servedUnreadable(ask, `the ${provider} read failed: ${(err as Error).message}`);
  }
}
