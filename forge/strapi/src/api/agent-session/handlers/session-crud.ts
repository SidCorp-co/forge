import type { Context } from 'koa';

const UID = 'api::agent-session.agent-session' as any;

export async function find(ctx: Context, strapi: any) {
  const { filters, sort, pagination, populate, search } = ctx.query as any;

  const result = await strapi.documents(UID).findMany({
    populate: populate || ['project', 'user'],
    filters: filters || undefined,
    sort: sort || undefined,
    limit: pagination?.pageSize ? Number(pagination.pageSize) : 25,
    start: pagination?.page
      ? (Number(pagination.page) - 1) * (Number(pagination.pageSize) || 25)
      : 0,
  });

  if (!search?.trim()) {
    return { data: result };
  }

  // Server-side search: re-query with messages to filter by content
  const q = search.toLowerCase();
  const allWithMessages = await strapi.documents(UID).findMany({
    populate: ['project', 'user'],
    filters: filters || undefined,
    sort: sort || undefined,
    limit: pagination?.pageSize ? Number(pagination.pageSize) : 100,
  });

  const matched = allWithMessages.filter((s: any) => {
    if ((s.title || '').toLowerCase().includes(q)) return true;
    if (!Array.isArray(s.messages)) return false;
    return s.messages.some((m: any) => {
      if (typeof m.content === 'string') return m.content.toLowerCase().includes(q);
      if (Array.isArray(m.content)) {
        return m.content.some((b: any) => b.type === 'text' && b.text?.toLowerCase().includes(q));
      }
      return false;
    });
  });

  // Strip messages from response
  const data = matched.map(({ messages, ...rest }: any) => rest);
  return { data };
}

export async function findOne(ctx: Context, strapi: any) {
  const { id } = ctx.params;
  const result = await strapi.documents(UID).findOne({
    documentId: id,
    populate: ['project', 'user'],
  });
  if (!result) {
    return ctx.notFound('Agent session not found');
  }
  return { data: result };
}
