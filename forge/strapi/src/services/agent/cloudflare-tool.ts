import type { ForgeTool } from './tools';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const CF_UID = 'api::cloudflare-account.cloudflare-account' as any;

interface CloudflareAccount {
  documentId: string;
  name: string;
  accountId: string;
  apiToken: string;
  status: string;
}

async function cfFetch(
  token: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal,
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${CF_BASE}${path}`, opts);
  const json = await res.json() as any;

  if (!res.ok || !json.success) {
    const msg = json.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export const forgeCloudflare: ForgeTool = {
  name: 'forge_cloudflare',
  description: 'Cloudflare domains/DNS. Actions: list_accounts, list_zones, zone_details, dns_list, dns_create, dns_update, dns_delete, purge_cache.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list_accounts',
          'list_zones',
          'zone_details',
          'dns_list',
          'dns_create',
          'dns_update',
          'dns_delete',
          'purge_cache',
        ],
      },
      account: { type: 'string', description: 'Account name or documentId (required for most actions)' },
      zone: { type: 'string', description: 'Zone ID (required for zone/DNS/cache actions)' },
      record_id: { type: 'string', description: 'DNS record ID (for dns_update/dns_delete)' },
      type: { type: 'string', description: 'DNS record type (A, AAAA, CNAME, MX, TXT, etc.)' },
      name: { type: 'string', description: 'DNS record name' },
      content: { type: 'string', description: 'DNS record content/value' },
      ttl: { type: 'number', description: 'TTL in seconds (1 = auto)' },
      proxied: { type: 'boolean', description: 'Whether to proxy through Cloudflare' },
      priority: { type: 'number', description: 'MX priority' },
      files: { type: 'array', items: { type: 'string' }, description: 'URLs to purge (for purge_cache, omit for purge all)' },
    },
    required: ['action'],
  },

  async execute(input, ctx) {
    const action = input.action as string;

    // Fetch all accounts (server-side, includes private apiToken)
    const allAccounts = (await ctx.strapi.db.query(CF_UID).findMany()) as CloudflareAccount[];

    if (action === 'list_accounts') {
      return JSON.stringify(
        allAccounts.map((a) => ({
          documentId: a.documentId,
          name: a.name,
          accountId: a.accountId,
          status: a.status,
        })),
      );
    }

    // All other actions require an account
    const identifier = input.account as string | undefined;
    if (!identifier) {
      return `Error: account is required. Available: ${allAccounts.map((a) => a.name).join(', ')}`;
    }

    const account = allAccounts.find(
      (a) =>
        a.documentId === identifier ||
        a.name.toLowerCase() === identifier.toLowerCase(),
    );
    if (!account) {
      return `Error: Account not found. Available: ${allAccounts.map((a) => a.name).join(', ')}`;
    }
    if (!account.apiToken) {
      return `Error: No API token configured for account "${account.name}".`;
    }

    const token = account.apiToken;
    const zoneId = input.zone as string | undefined;

    try {
      if (action === 'list_zones') {
        const params = new URLSearchParams({ 'account.id': account.accountId, per_page: '50' });
        const json = await cfFetch(token, `/zones?${params}`, 'GET', undefined, ctx.signal);
        return JSON.stringify(
          json.result.map((z: any) => ({
            id: z.id,
            name: z.name,
            status: z.status,
            paused: z.paused,
            name_servers: z.name_servers,
          })),
        );
      }

      if (action === 'zone_details') {
        if (!zoneId) return 'Error: zone is required for zone_details';
        const json = await cfFetch(token, `/zones/${zoneId}`, 'GET', undefined, ctx.signal);
        const z = json.result;
        return JSON.stringify({
          id: z.id,
          name: z.name,
          status: z.status,
          paused: z.paused,
          name_servers: z.name_servers,
          plan: z.plan?.name,
          original_name_servers: z.original_name_servers,
        });
      }

      if (action === 'dns_list') {
        if (!zoneId) return 'Error: zone is required for dns_list';
        const params = new URLSearchParams({ per_page: '100' });
        if (input.type) params.set('type', input.type as string);
        if (input.name) params.set('name', input.name as string);
        const json = await cfFetch(token, `/zones/${zoneId}/dns_records?${params}`, 'GET', undefined, ctx.signal);
        return JSON.stringify(
          json.result.map((r: any) => ({
            id: r.id,
            type: r.type,
            name: r.name,
            content: r.content,
            proxied: r.proxied,
            ttl: r.ttl,
            priority: r.priority,
          })),
        );
      }

      if (action === 'dns_create') {
        if (!zoneId) return 'Error: zone is required for dns_create';
        if (!input.type || !input.name || !input.content) {
          return 'Error: type, name, and content are required for dns_create';
        }
        const body: Record<string, unknown> = {
          type: input.type,
          name: input.name,
          content: input.content,
          ttl: (input.ttl as number) || 1,
          proxied: input.proxied ?? false,
        };
        if (input.priority !== undefined) body.priority = input.priority;
        const json = await cfFetch(token, `/zones/${zoneId}/dns_records`, 'POST', body, ctx.signal);
        return JSON.stringify({ id: json.result.id, name: json.result.name, type: json.result.type, status: 'created' });
      }

      if (action === 'dns_update') {
        if (!zoneId) return 'Error: zone is required for dns_update';
        if (!input.record_id) return 'Error: record_id is required for dns_update';
        const body: Record<string, unknown> = {};
        if (input.type) body.type = input.type;
        if (input.name) body.name = input.name;
        if (input.content) body.content = input.content;
        if (input.ttl !== undefined) body.ttl = input.ttl;
        if (input.proxied !== undefined) body.proxied = input.proxied;
        if (input.priority !== undefined) body.priority = input.priority;
        const json = await cfFetch(token, `/zones/${zoneId}/dns_records/${input.record_id}`, 'PATCH', body, ctx.signal);
        return JSON.stringify({ id: json.result.id, name: json.result.name, status: 'updated' });
      }

      if (action === 'dns_delete') {
        if (!zoneId) return 'Error: zone is required for dns_delete';
        if (!input.record_id) return 'Error: record_id is required for dns_delete';
        await cfFetch(token, `/zones/${zoneId}/dns_records/${input.record_id}`, 'DELETE', undefined, ctx.signal);
        return JSON.stringify({ id: input.record_id, status: 'deleted' });
      }

      if (action === 'purge_cache') {
        if (!zoneId) return 'Error: zone is required for purge_cache';
        const files = input.files as string[] | undefined;
        const body = files?.length ? { files } : { purge_everything: true };
        await cfFetch(token, `/zones/${zoneId}/purge_cache`, 'POST', body, ctx.signal);
        return JSON.stringify({ zone: zoneId, status: 'purged', scope: files?.length ? `${files.length} files` : 'everything' });
      }

      return `Unknown action: ${action}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
};
