import { randomBytes } from 'node:crypto';
import type { BindingRole } from '../db/release-axes.js';
import {
  AGENT_ACCESS_CLOSED,
  type AgentAccess,
  agentAccessTier,
  noAgentPathMessage,
} from '../integrations/agent-access.js';
import { getAdapter, getIntegration } from '../integrations/registry.js';
import {
  broadcastIntegrationChanged,
  notifyConnectionChanged,
  runInitialHealthcheck,
} from '../integrations/route-helpers.js';
import { findBindingWithConnectionById, findConnectionById } from '../integrations/store.js';
import { effectiveProjectRole, orgRoleAtLeast } from '../lib/authz.js';
import type { ApiRefusal } from './documents.js';

export interface BindEffects {
  refusals(input: {
    userId: string;
    projectId: string;
    provider: string;
    label: string;
    agentAccess: AgentAccess;
  }): Promise<ApiRefusal[]>;
  inboundSecret(connectionId: string): Promise<string>;
  targetRefusals(input: {
    connectionId: string;
    provider: string;
    config: Record<string, unknown>;
    held: Record<string, unknown> | null;
  }): Promise<ApiRefusal[]>;
  afterWrite(input: {
    bindingId: string;
    projectId: string;
    connectionId: string;
    provider: string;
    role: BindingRole;
    config: Record<string, unknown>;
    created: boolean;
  }): Promise<Record<string, unknown>>;
}

export const bindEffects: BindEffects = {
  async refusals({ userId, projectId, provider, label, agentAccess }) {
    const out: ApiRefusal[] = [];
    if (label !== '' && !getIntegration(provider)?.capabilities.multiBinding) {
      out.push({
        code: 'BINDING_LABEL_UNSUPPORTED',
        path: '/target/label',
        detail: `\`${provider}\` holds one binding per project, so its target takes no \`label\`; a label names one of several bindings of a provider that declares \`multiBinding\`.`,
      });
    }
    if (agentAccess === AGENT_ACCESS_CLOSED) return out;
    const tier = agentAccessTier(getIntegration(provider));
    if (tier === 'refused') {
      out.push({
        code: 'AGENT_ACCESS_UNSUPPORTED',
        path: '/agentAccess',
        detail: noAgentPathMessage(provider),
      });
    } else if (tier === 'org-admin') {
      const access = await effectiveProjectRole(userId, projectId);
      if (!orgRoleAtLeast(access?.orgRole ?? null, 'admin')) {
        out.push({
          code: 'AGENT_ACCESS_NEEDS_ORG_ADMIN',
          path: '/agentAccess',
          detail: `granting agents ${provider} puts its credential on a runner box, which takes an admin of this project's organisation.`,
        });
      }
    }
    return out;
  },

  async inboundSecret(connectionId) {
    const connection = await findConnectionById(connectionId);
    const provider = connection?.provider;
    const own = connection && provider ? getAdapter(provider)?.inboundSecret?.(connection) : null;
    return own ?? `whsec_${randomBytes(24).toString('hex')}`;
  },

  async targetRefusals({ connectionId, provider, config, held }) {
    const verify = getAdapter(provider)?.verifyBindingTarget;
    if (!verify) return [];
    const connection = await findConnectionById(connectionId);
    if (!connection) return [];
    const refused = await verify({ connection, config, held });
    return refused.map((r) => ({ ...r, path: `/target${r.path}` }));
  },

  async afterWrite({ bindingId, projectId, connectionId, provider, role, config, created }) {
    let effects: Record<string, unknown> = {};
    if (created) {
      effects = (await getAdapter(provider)?.onBindingCreated?.({ projectId, role, config })) ?? {};
      const pair = await findBindingWithConnectionById(bindingId);
      if (pair) effects = { ...effects, health: await runInitialHealthcheck(pair) };
    }
    broadcastIntegrationChanged(projectId, { bindingId, connectionId });
    notifyConnectionChanged(provider, connectionId);
    return effects;
  },
};
