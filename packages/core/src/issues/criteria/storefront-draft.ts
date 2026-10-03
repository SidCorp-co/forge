import type { VerdictCorroboration } from '@forge/contracts/verdict-identity';
import { getIntegration } from '../../integrations/registry.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
} from '../../integrations/store.js';
import type { StorefrontDraftReading } from '../../integrations/types.js';
import type { ProjectDocument } from '../../project-config/schema.js';
import type { VerdictIdentity, VerdictRefusal } from './verdict-input.js';

type StorefrontDraft = Extract<VerdictIdentity, { kind: 'storefront_draft' }>;

export interface DraftCorroboration {
  readonly corroboration: VerdictCorroboration;
  readonly note: string | null;
}

export type DraftReader = (
  document: ProjectDocument | null,
  workflowId: string,
) => Promise<StorefrontDraftReading>;

export function environmentFault(
  criterion: number,
  document: ProjectDocument | null,
  environment: string,
): VerdictRefusal | null {
  const declared = document ? Object.keys(document.environments) : [];
  const env = document?.environments[environment];
  if (env && env.tier !== 'production') return null;
  const detail = !document
    ? `criterion ${criterion} names environment \`${environment}\`, and this project declares no project document, so it declares no environment to judge a draft on.`
    : env
      ? `criterion ${criterion} names environment \`${environment}\`, whose tier is production: a storefront draft is unpublished, so it is judged on a preview, staging or dev environment, and a published version is judged at release.`
      : `criterion ${criterion} names environment \`${environment}\`, which the project document does not declare; it declares ${declared.map((k) => `\`${k}\``).join(', ') || 'none'}.`;
  return { code: 'VERDICT_ENVIRONMENT_UNKNOWN', criterion, detail };
}

export function corroborationOf(
  identity: StorefrontDraft,
  reading: StorefrontDraftReading,
): DraftCorroboration {
  if (reading.kind !== 'read') return { corroboration: 'uncorroborated', note: reading.detail };
  if (reading.draftVersion === identity.draftVersion.trim()) {
    return { corroboration: 'corroborated', note: null };
  }
  return {
    corroboration: 'uncorroborated',
    note: `the storefront source holds workflow \`${identity.workflowId}\`${reading.workflowCode ? ` (\`${reading.workflowCode}\`)` : ''} at draft version \`${reading.draftVersion}\` now, not \`${identity.draftVersion}\`: the draft moved after it was judged, or the version was not copied from \`forge_storefront_target\` \`workflows[].draftVersion\``,
  };
}

export const readSourceDraft: DraftReader = async (document, workflowId) => {
  if (!document) {
    return {
      kind: 'unreadable',
      detail: 'this project declares no project document, so it names no storefront source',
    };
  }
  if (document.source.type !== 'storefront') {
    return {
      kind: 'unreadable',
      detail: `this project's source is \`${document.source.type}\`, not a storefront: no provider holds a draft of its work for core to read`,
    };
  }
  const { provider, binding } = document.source.storefront;
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
};
