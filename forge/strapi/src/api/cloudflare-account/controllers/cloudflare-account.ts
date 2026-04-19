import { factories } from '@strapi/strapi';

const UID = 'api::cloudflare-account.cloudflare-account' as any;
const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfApiFetch(token: string, path: string, method = 'GET', body?: Record<string, unknown>) {
  const opts: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${CF_BASE}${path}`, opts);
  const json = (await res.json()) as any;
  if (!res.ok || !json.success) {
    const msg = json.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/** Fetch account with apiToken (private field) via db.query */
async function getAccountWithToken(strapi: any, documentId: string) {
  return strapi.db.query(UID).findOne({ where: { documentId }, populate: ['user'] });
}

export default factories.createCoreController(UID, ({ strapi }) => ({
  // List accounts filtered to current user
  async find(ctx) {
    if (ctx.state.user) {
      const userAccounts: any[] = await strapi.documents(UID).findMany({
        filters: { user: { id: { $eq: ctx.state.user.id } } },
        populate: ['user'],
      });
      return { data: userAccounts.map(sanitize), meta: { pagination: { total: userAccounts.length } } };
    }
    return super.find(ctx);
  },

  // Create a new Cloudflare account
  async create(ctx) {
    const body = (ctx.request.body as any)?.data || ctx.request.body;
    const { name, accountId, apiToken } = body;

    if (!name || !accountId) {
      ctx.status = 400;
      return { error: 'name and accountId are required' };
    }

    const data: Record<string, any> = {
      name,
      accountId,
      apiToken: apiToken || null,
      status: 'active',
      user: ctx.state.user?.documentId,
    };

    const account = await strapi.documents(UID).create({ data: data as any });
    ctx.status = 201;
    return { data: sanitize(account) };
  },

  // Update account fields
  async updateAccount(ctx) {
    const { documentId } = ctx.params;
    const body = (ctx.request.body as any)?.data || ctx.request.body;

    const existing: any = await strapi.documents(UID).findOne({
      documentId,
      populate: ['user'],
    });
    if (!existing) {
      ctx.status = 404;
      return { error: 'Account not found' };
    }
    if (ctx.state.user && existing.user?.id !== ctx.state.user.id) {
      ctx.status = 403;
      return { error: 'You can only update your own accounts' };
    }

    const updates: Record<string, any> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.accountId !== undefined) updates.accountId = body.accountId;
    if (body.apiToken !== undefined) updates.apiToken = body.apiToken;

    const account = await strapi.documents(UID).update({
      documentId,
      data: updates as any,
    });
    return { data: sanitize(account) };
  },

  // Delete an account
  async deleteAccount(ctx) {
    const { documentId } = ctx.params;

    const existing: any = await strapi.documents(UID).findOne({
      documentId,
      populate: ['user'],
    });
    if (!existing) {
      ctx.status = 404;
      return { error: 'Account not found' };
    }
    if (ctx.state.user && existing.user?.id !== ctx.state.user.id) {
      ctx.status = 403;
      return { error: 'You can only delete your own accounts' };
    }

    await strapi.documents(UID).delete({ documentId });
    return { data: { ok: true } };
  },

  // Validate API token against Cloudflare
  async validate(ctx) {
    const { documentId } = ctx.params;

    const account: any = await getAccountWithToken(strapi, documentId);
    if (!account) {
      ctx.status = 404;
      return { error: 'Account not found' };
    }
    if (ctx.state.user && account.user?.id !== ctx.state.user.id) {
      ctx.status = 403;
      return { error: 'You can only validate your own accounts' };
    }

    if (!account.apiToken) {
      ctx.status = 400;
      return { error: 'No API token configured for this account' };
    }

    try {
      // Account-scoped tokens (cfat_) use /accounts/:id/tokens/verify
      // User-scoped tokens use /user/tokens/verify
      const verifyPath = account.apiToken.startsWith('cfat_')
        ? `${CF_BASE}/accounts/${account.accountId}/tokens/verify`
        : `${CF_BASE}/user/tokens/verify`;
      const res = await fetch(verifyPath, {
        method: 'GET',
        headers: { Authorization: `Bearer ${account.apiToken}`, 'Content-Type': 'application/json' },
      });

      const json = (await res.json()) as any;
      const now = new Date().toISOString();

      if (res.ok && json.success) {
        await strapi.documents(UID).update({
          documentId,
          data: { status: 'active', lastValidated: now, validationError: null } as any,
        });
        return { data: { status: 'active', lastValidated: now } };
      }

      const errorMsg = json.errors?.[0]?.message || `HTTP ${res.status}`;
      await strapi.documents(UID).update({
        documentId,
        data: { status: 'error', lastValidated: now, validationError: errorMsg } as any,
      });
      return { data: { status: 'error', lastValidated: now, validationError: errorMsg } };
    } catch (err: any) {
      const now = new Date().toISOString();
      const errorMsg = err.message || 'Connection failed';
      await strapi.documents(UID).update({
        documentId,
        data: { status: 'error', lastValidated: now, validationError: errorMsg } as any,
      });
      return { data: { status: 'error', lastValidated: now, validationError: errorMsg } };
    }
  },

  // ── Cloudflare API proxy endpoints ──────────────────────────────

  // GET /cloudflare-accounts/:documentId/zones
  async listZones(ctx) {
    const account: any = await getAccountWithToken(strapi, ctx.params.documentId);
    if (!account) { ctx.status = 404; return { error: 'Account not found' }; }
    if (!account.apiToken) { ctx.status = 400; return { error: 'No API token configured' }; }

    try {
      const params = new URLSearchParams({ 'account.id': account.accountId, per_page: '50' });
      const json = await cfApiFetch(account.apiToken, `/zones?${params}`);
      return {
        data: json.result.map((z: any) => ({
          id: z.id,
          name: z.name,
          status: z.status,
          paused: z.paused,
          name_servers: z.name_servers,
          plan: z.plan?.name,
        })),
      };
    } catch (err: any) {
      ctx.status = 502;
      return { error: err.message };
    }
  },

  // GET /cloudflare-accounts/:documentId/zones/:zoneId/dns
  async listDns(ctx) {
    const account: any = await getAccountWithToken(strapi, ctx.params.documentId);
    if (!account) { ctx.status = 404; return { error: 'Account not found' }; }
    if (!account.apiToken) { ctx.status = 400; return { error: 'No API token configured' }; }

    const { zoneId } = ctx.params;
    const q = ctx.query as Record<string, string>;
    const params = new URLSearchParams({ per_page: '100' });
    if (q.type) params.set('type', q.type);
    if (q.name) params.set('name', q.name);

    try {
      const json = await cfApiFetch(account.apiToken, `/zones/${zoneId}/dns_records?${params}`);
      return {
        data: json.result.map((r: any) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          content: r.content,
          proxied: r.proxied,
          ttl: r.ttl,
          priority: r.priority,
        })),
      };
    } catch (err: any) {
      ctx.status = 502;
      return { error: err.message };
    }
  },

  // POST /cloudflare-accounts/:documentId/zones/:zoneId/dns
  async createDns(ctx) {
    const account: any = await getAccountWithToken(strapi, ctx.params.documentId);
    if (!account) { ctx.status = 404; return { error: 'Account not found' }; }
    if (!account.apiToken) { ctx.status = 400; return { error: 'No API token configured' }; }

    const { zoneId } = ctx.params;
    const body = (ctx.request.body as any)?.data || ctx.request.body;
    if (!body.type || !body.name || !body.content) {
      ctx.status = 400;
      return { error: 'type, name, and content are required' };
    }

    const record: Record<string, unknown> = {
      type: body.type,
      name: body.name,
      content: body.content,
      ttl: body.ttl || 1,
      proxied: body.proxied ?? false,
    };
    if (body.priority !== undefined) record.priority = body.priority;

    try {
      const json = await cfApiFetch(account.apiToken, `/zones/${zoneId}/dns_records`, 'POST', record);
      ctx.status = 201;
      return { data: { id: json.result.id, type: json.result.type, name: json.result.name, content: json.result.content, status: 'created' } };
    } catch (err: any) {
      ctx.status = 502;
      return { error: err.message };
    }
  },

  // PUT /cloudflare-accounts/:documentId/zones/:zoneId/dns/:recordId
  async updateDns(ctx) {
    const account: any = await getAccountWithToken(strapi, ctx.params.documentId);
    if (!account) { ctx.status = 404; return { error: 'Account not found' }; }
    if (!account.apiToken) { ctx.status = 400; return { error: 'No API token configured' }; }

    const { zoneId, recordId } = ctx.params;
    const body = (ctx.request.body as any)?.data || ctx.request.body;
    const updates: Record<string, unknown> = {};
    if (body.type) updates.type = body.type;
    if (body.name) updates.name = body.name;
    if (body.content) updates.content = body.content;
    if (body.ttl !== undefined) updates.ttl = body.ttl;
    if (body.proxied !== undefined) updates.proxied = body.proxied;
    if (body.priority !== undefined) updates.priority = body.priority;

    try {
      const json = await cfApiFetch(account.apiToken, `/zones/${zoneId}/dns_records/${recordId}`, 'PATCH', updates);
      return { data: { id: json.result.id, name: json.result.name, status: 'updated' } };
    } catch (err: any) {
      ctx.status = 502;
      return { error: err.message };
    }
  },

  // DELETE /cloudflare-accounts/:documentId/zones/:zoneId/dns/:recordId
  async deleteDns(ctx) {
    const account: any = await getAccountWithToken(strapi, ctx.params.documentId);
    if (!account) { ctx.status = 404; return { error: 'Account not found' }; }
    if (!account.apiToken) { ctx.status = 400; return { error: 'No API token configured' }; }

    const { zoneId, recordId } = ctx.params;
    try {
      await cfApiFetch(account.apiToken, `/zones/${zoneId}/dns_records/${recordId}`, 'DELETE');
      return { data: { id: recordId, status: 'deleted' } };
    } catch (err: any) {
      ctx.status = 502;
      return { error: err.message };
    }
  },

  // POST /cloudflare-accounts/:documentId/zones/:zoneId/purge
  async purgeCache(ctx) {
    const account: any = await getAccountWithToken(strapi, ctx.params.documentId);
    if (!account) { ctx.status = 404; return { error: 'Account not found' }; }
    if (!account.apiToken) { ctx.status = 400; return { error: 'No API token configured' }; }

    const { zoneId } = ctx.params;
    const body = (ctx.request.body as any) || {};
    const purgeBody = body.files?.length ? { files: body.files } : { purge_everything: true };

    try {
      await cfApiFetch(account.apiToken, `/zones/${zoneId}/purge_cache`, 'POST', purgeBody);
      return { data: { zone: zoneId, status: 'purged' } };
    } catch (err: any) {
      ctx.status = 502;
      return { error: err.message };
    }
  },
}));

function sanitize(account: any) {
  return {
    id: account.id,
    documentId: account.documentId,
    name: account.name,
    accountId: account.accountId,
    status: account.status,
    lastValidated: account.lastValidated,
    validationError: account.validationError,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
