import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
  forgeReads,
  getIntegration,
  grantHolds,
  listBindingsForProject,
  listIntegrations,
  notGrantedMessage,
} from '../index.js';
import { SourceHostUnavailable } from './errors.js';
import type { SourceHost, SourceHostFactory } from './types.js';

/** `kernel` reads and merges for Forge itself; `agent` is an agent's verb and needs the grant. */
type SourceHostPurpose = 'kernel' | 'agent';

/** The host name `source.git.repository` is served from, or null where none is declared. */
export function hostOfRepository(repository: string | null): string | null {
  if (!repository) return null;
  const slash = repository.indexOf('/');
  return slash > 0 ? repository.slice(0, slash).toLowerCase() : null;
}

function factoryOf(provider: string): SourceHostFactory | undefined {
  return getIntegration(provider)?.sourceHost;
}

/** Every provider a project's repository can live on, for a refusal that names them. */
function hostProviders(): string[] {
  return listIntegrations()
    .filter((d) => d.sourceHost !== undefined)
    .map((d) => d.provider);
}

function buildFrom(pair: BindingWithConnection): SourceHost {
  const factory = factoryOf(pair.binding.provider);
  if (!factory) {
    throw new SourceHostUnavailable(
      'no_binding',
      `binding ${pair.binding.id} is a \`${pair.binding.provider}\` binding, and \`${pair.binding.provider}\` is not a host a repository lives on — the source hosts are ${hostProviders().join(', ')}`,
      pair.binding.id,
    );
  }
  return factory.build({
    bindingId: pair.binding.id,
    config: effectiveConfig(pair),
    secrets: decryptConnectionSecrets(pair.connection),
  });
}

/**
 * The host a project's repository is read and written through, or the refusal naming why not.
 *
 * Candidates are the project's bindings of every provider declaring `sourceHost`, oldest first.
 * Where the project document declares a repository, only a binding serving that repository's host
 * is a candidate: a GitHub binding on a project whose repository is on gitlab.com is refused as
 * `host_mismatch`, never read as if it reached that repository. A `kernel` read takes only active
 * bindings, so a project with none answers `no_binding`; an
 * `agent` verb tells a switched-off binding and an ungranted one apart.
 */
export async function resolveSourceHost(
  projectId: string,
  purpose: SourceHostPurpose = 'kernel',
): Promise<SourceHost> {
  const all = (await listBindingsForProject(projectId))
    .filter((pair) => factoryOf(pair.binding.provider) !== undefined)
    .sort((a, b) => a.binding.createdAt.getTime() - b.binding.createdAt.getTime());
  const considered =
    purpose === 'kernel' ? all.filter((p) => p.binding.active && p.connection.active) : all;
  if (considered.length === 0) {
    throw new SourceHostUnavailable(
      'no_binding',
      `this project has no active source host binding (${hostProviders().join(' or ')}) — bind its repository on the Integrations page`,
    );
  }

  const declaredHost = hostOfRepository(await forgeReads().declaredRepository(projectId));
  const onHost = declaredHost
    ? considered.filter(
        (p) => factoryOf(p.binding.provider)?.hostOf(effectiveConfig(p)) === declaredHost,
      )
    : considered;
  if (onHost.length === 0) {
    const bound = considered
      .map(
        (p) =>
          `${p.binding.provider} on ${factoryOf(p.binding.provider)?.hostOf(effectiveConfig(p))}`,
      )
      .join(', ');
    throw new SourceHostUnavailable(
      'host_mismatch',
      `the project document declares a repository on ${declaredHost}, and its source host binding reaches ${bound} — bind the repository's own host, or change \`source.git.repository\``,
      considered[0]?.binding.id ?? null,
    );
  }

  if (purpose === 'kernel') return buildFrom(onHost[0] as BindingWithConnection);

  const usable = onHost.filter((p) => p.binding.active && p.connection.active);
  const first = usable[0];
  if (!first) {
    const dead = onHost[0] as BindingWithConnection;
    const which = !dead.connection.active
      ? `its ${dead.binding.provider} credential is switched off for every project sharing it`
      : 'the binding is switched off for this project';
    throw new SourceHostUnavailable(
      'binding_disabled',
      `this project's ${dead.binding.provider} binding exists but ${which} — re-enable it under Settings → Integrations. Nothing was sent to ${dead.binding.provider}.`,
      dead.binding.id,
    );
  }
  if (!grantHolds(getIntegration(first.binding.provider), first.binding)) {
    throw new SourceHostUnavailable(
      'not_granted',
      notGrantedMessage(first.binding.provider, first.binding.id),
      first.binding.id,
    );
  }
  return buildFrom(first);
}

/**
 * The host one stored binding serves — the door a stored change request's merge takes, because the
 * row names its own binding and re-resolving by project could pick a different repository.
 */
export async function sourceHostForBinding(bindingId: string): Promise<SourceHost> {
  const pair = await findBindingWithConnectionById(bindingId);
  if (!pair?.binding.active) {
    throw new SourceHostUnavailable(
      'no_binding',
      `the source host binding ${bindingId} this change request was stored under is gone or deactivated`,
      bindingId,
    );
  }
  if (!pair.connection.active) {
    throw new SourceHostUnavailable(
      'no_connection',
      `the ${pair.binding.provider} connection behind binding ${bindingId} is gone or deactivated`,
      bindingId,
    );
  }
  return buildFrom(pair);
}
