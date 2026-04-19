import type { ForgeTool } from './tools';

interface CoolifyResource {
  name: string;
  uuid: string;
}

export const forgeCoolifyDeploy: ForgeTool = {
  name: 'forge_coolify_deploy',
  description: 'Coolify apps. Actions: list, deploy, status, get, logs, start, stop, restart, envs, set-env, delete-env, cancel-deploy.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list',
          'deploy',
          'status',
          'get',
          'logs',
          'start',
          'stop',
          'restart',
          'envs',
          'set-env',
          'delete-env',
          'cancel-deploy',
        ],
      },
      uuid: { type: 'string', description: 'Resource uuid or name' },
      force: { type: 'boolean' },
      key: { type: 'string', description: 'Env variable key (for set-env)' },
      value: { type: 'string', description: 'Env variable value (for set-env)' },
      is_preview: { type: 'boolean', description: 'Whether env is for preview deployments (for set-env)' },
      env_uuid: { type: 'string', description: 'Env variable UUID (for delete-env)' },
      deployment_uuid: { type: 'string', description: 'Deployment UUID (for cancel-deploy)' },
      lines: { type: 'number', description: 'Number of log lines (for logs, default 100)' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;

    const coolifyUrl = process.env.COOLIFY_URL;
    const coolifyApiKey = process.env.COOLIFY_API_KEY;

    if (!coolifyUrl || !coolifyApiKey) {
      return 'Error: Coolify not configured. Set COOLIFY_URL and COOLIFY_API_KEY environment variables.';
    }

    const project = await ctx.strapi.documents('api::project.project').findOne({
      documentId: ctx.projectDocumentId,
      fields: ['coolifyResources'],
    });

    if (!project) return 'Error: project not found';

    const resources = ((project as any).coolifyResources ?? []) as CoolifyResource[];
    if (resources.length === 0) {
      return 'Error: No Coolify resources configured. Add resources in project settings.';
    }

    const baseUrl = coolifyUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${coolifyApiKey}`,
      Accept: 'application/json',
    };

    if (action === 'list') {
      return JSON.stringify(resources);
    }

    // Resolve which resource(s) to target
    const resolveTargets = (): CoolifyResource[] => {
      const identifier = input.uuid as string | undefined;
      if (!identifier) return resources; // all
      const match = resources.find(
        (r) => r.uuid === identifier || r.name.toLowerCase() === identifier.toLowerCase(),
      );
      return match ? [match] : [];
    };

    // Resolve a single required target
    const resolveSingleTarget = (): CoolifyResource | string => {
      const identifier = input.uuid as string | undefined;
      if (!identifier) {
        return `Error: uuid is required for ${action}. Available: ${resources.map((r) => `${r.name} (${r.uuid})`).join(', ')}`;
      }
      const match = resources.find(
        (r) => r.uuid === identifier || r.name.toLowerCase() === identifier.toLowerCase(),
      );
      if (!match) {
        return `Error: Resource not found. Available: ${resources.map((r) => `${r.name} (${r.uuid})`).join(', ')}`;
      }
      return match;
    };

    // Helper for simple GET requests against an application endpoint
    const appGet = async (target: CoolifyResource, path: string, params?: URLSearchParams): Promise<Record<string, any>> => {
      const url = params
        ? `${baseUrl}/api/v1/applications/${target.uuid}${path}?${params}`
        : `${baseUrl}/api/v1/applications/${target.uuid}${path}`;
      const res = await fetch(url, { method: 'GET', headers, signal: ctx.signal });
      if (!res.ok) {
        const text = await res.text();
        return { error: `${action} failed for ${target.name} (${res.status}): ${text}` };
      }
      return res.json() as Promise<Record<string, any>>;
    };

    if (action === 'deploy') {
      const targets = resolveTargets();
      if (targets.length === 0) {
        return `Error: Resource not found. Available: ${resources.map((r) => `${r.name} (${r.uuid})`).join(', ')}`;
      }

      const uuids = targets.map((t) => t.uuid).join(',');
      const params = new URLSearchParams({ uuid: uuids });
      if (input.force) params.set('force', 'true');

      const res = await fetch(`${baseUrl}/api/v1/deploy?${params}`, {
        method: 'GET',
        headers,
        signal: ctx.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        return `Error: deploy failed (${res.status}): ${text}`;
      }

      return JSON.stringify(await res.json());
    }

    if (action === 'status') {
      const targets = resolveTargets();
      if (targets.length === 0) {
        return `Error: Resource not found. Available: ${resources.map((r) => `${r.name} (${r.uuid})`).join(', ')}`;
      }

      const results: Record<string, any> = {};
      for (const target of targets) {
        const res = await fetch(`${baseUrl}/api/v1/deployments/applications/${target.uuid}`, {
          method: 'GET',
          headers,
          signal: ctx.signal,
        });
        if (!res.ok) {
          results[target.name] = { error: `Failed (${res.status})` };
        } else {
          const deployments = (await res.json()) as any[];
          results[target.name] = (Array.isArray(deployments) ? deployments : [deployments])
            .slice(0, 3)
            .map((d: any) => ({
              deployment_uuid: d.uuid,
              status: d.status,
              created_at: d.created_at,
              commit_message: d.commit_message,
            }));
        }
      }
      return JSON.stringify(results);
    }

    if (action === 'get') {
      const target = resolveSingleTarget();
      if (typeof target === 'string') return target;
      const data = await appGet(target, '');
      if (data.error) return `Error: ${data.error}`;
      return JSON.stringify({
        uuid: data.uuid,
        name: data.name,
        fqdn: data.fqdn,
        status: data.status,
        repository: data.git_repository,
        branch: data.git_branch,
        build_pack: data.build_pack,
        last_deployment_at: data.last_deployment_at,
      });
    }

    if (action === 'logs') {
      const target = resolveSingleTarget();
      if (typeof target === 'string') return target;
      const lines = (input.lines as number) || 100;
      const data = await appGet(target, '/logs', new URLSearchParams({ lines: String(lines) }));
      if (data.error) return `Error: ${data.error}`;
      return JSON.stringify(data);
    }

    if (action === 'start' || action === 'stop' || action === 'restart') {
      const target = resolveSingleTarget();
      if (typeof target === 'string') return target;
      const data = await appGet(target, `/${action}`);
      if (data.error) return `Error: ${data.error}`;
      return JSON.stringify(data);
    }

    if (action === 'envs') {
      const target = resolveSingleTarget();
      if (typeof target === 'string') return target;
      const data = await appGet(target, '/envs');
      if (data.error) return `Error: ${data.error}`;
      return JSON.stringify(data);
    }

    if (action === 'set-env') {
      const target = resolveSingleTarget();
      if (typeof target === 'string') return target;
      const key = input.key as string | undefined;
      const value = input.value as string | undefined;
      if (!key) return 'Error: key is required for set-env';
      if (value === undefined) return 'Error: value is required for set-env';

      const res = await fetch(`${baseUrl}/api/v1/applications/${target.uuid}/envs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, is_preview: input.is_preview ?? false }),
        signal: ctx.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        return `Error: set-env failed for ${target.name} (${res.status}): ${text}`;
      }
      return JSON.stringify(await res.json());
    }

    if (action === 'delete-env') {
      const target = resolveSingleTarget();
      if (typeof target === 'string') return target;
      const envUuid = input.env_uuid as string | undefined;
      if (!envUuid) return 'Error: env_uuid is required for delete-env';

      const res = await fetch(`${baseUrl}/api/v1/applications/${target.uuid}/envs/${envUuid}`, {
        method: 'DELETE',
        headers,
        signal: ctx.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        return `Error: delete-env failed for ${target.name} (${res.status}): ${text}`;
      }
      return JSON.stringify({ success: true, deleted: envUuid });
    }

    if (action === 'cancel-deploy') {
      const deploymentUuid = input.deployment_uuid as string | undefined;
      if (!deploymentUuid) return 'Error: deployment_uuid is required for cancel-deploy. Use status action first to get deployment UUIDs.';

      const res = await fetch(`${baseUrl}/api/v1/deployments/${deploymentUuid}/cancel`, {
        method: 'POST',
        headers,
        signal: ctx.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        return `Error: cancel-deploy failed (${res.status}): ${text}`;
      }
      return JSON.stringify(await res.json());
    }

    return `Unknown action: ${action}`;
  },
};
