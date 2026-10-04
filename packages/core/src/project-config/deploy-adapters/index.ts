import type { EnvironmentStateRefusalCode } from '@forge/contracts/project-config';
import { getAdapter } from '../../integrations/registry.js';
import {
  buildContextFromBinding,
  findBindingWithConnectionById,
} from '../../integrations/store.js';
import { refuser } from '../../lib/refusal.js';
import type { TargetedDeployAdapter } from './types.js';

const refuse = refuser<EnvironmentStateRefusalCode>('BINDING_ROLE_MISMATCH');

export async function deployAdapterForBinding(
  projectId: string,
  bindingId: string,
  timeoutMs: number,
): Promise<TargetedDeployAdapter | null> {
  const pair = await findBindingWithConnectionById(bindingId);
  if (!pair || pair.binding.projectId !== projectId || !pair.binding.active) return null;
  if (pair.binding.role !== 'deploy') {
    throw refuse(
      'BINDING_ROLE_MISMATCH',
      `binding ${bindingId} has role \`${pair.binding.role}\`; an environment deploys through a binding of role \`deploy\``,
    );
  }
  const read = getAdapter(pair.binding.provider)?.deploymentRecords;
  if (!read) {
    throw refuse(
      'DEPLOY_HISTORY_UNSUPPORTED',
      `binding ${bindingId} goes through ${pair.binding.provider}, whose adapter does not read deployment history`,
    );
  }
  return read(buildContextFromBinding(pair), timeoutMs);
}
