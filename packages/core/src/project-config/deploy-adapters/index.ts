import type { EnvironmentStateRefusalCode } from '@forge/contracts/project-config';
import type { TargetedDeployAdapter } from '../../integrations/deploy/index.js';
import {
  buildContextFromBinding,
  findBindingWithConnectionById,
  getAdapter,
} from '../../integrations/index.js';
import { refuser } from '../../lib/refusal.js';

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
