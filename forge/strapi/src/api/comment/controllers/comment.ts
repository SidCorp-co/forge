import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams } from '../../../services/query-params';

const UID = 'api::comment.comment' as const;

/** Extract @mentions from comment body text */
function extractMentions(body: string): string[] {
  const matches = body.match(/@([a-zA-Z0-9_.-]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

/** Only populate what's needed — skip heavy issue relation (fetched via filter) */
const DEFAULT_POPULATE = {
  attachments: true,
  parent: { fields: ['documentId'] },
  replies: { fields: ['documentId'] },
} as const;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    if (!params.populate || params.populate === '*') params.populate = { ...DEFAULT_POPULATE };
    const results = await strapi.documents(UID).findMany(params);
    return { data: results };
  },

  async create(ctx: Context) {
    const { body, author, isAI, issue, parent, attachments } = ctx.request.body?.data || {};

    if (!body) return ctx.badRequest('body is required');

    const mentions = extractMentions(body);
    const data: any = { body, author: author || ctx.state.user?.username, isAI, mentions };
    if (issue) data.issue = issue;
    if (parent) data.parent = parent;
    if (attachments) data.attachments = attachments;

    const created = await strapi.documents(UID).create({ data });

    // Re-fetch with populate so the response includes full attachment data
    const result = await strapi.documents(UID).findOne({
      documentId: created.documentId,
      populate: { ...DEFAULT_POPULATE },
    } as any);

    ctx.status = 201;
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const { body } = ctx.request.body?.data || {};

    if (!body) return ctx.badRequest('body is required');

    const existing = await strapi.documents(UID).findOne({ documentId: id });
    if (!existing) return ctx.notFound('Comment not found');

    // Only comment author (or API key users) can edit
    const currentUser = ctx.state.user?.username;
    if (currentUser && existing.author && existing.author !== currentUser) {
      return ctx.forbidden('You can only edit your own comments');
    }

    const mentions = extractMentions(body);
    const result = await strapi.documents(UID).update({
      documentId: id,
      data: { body, mentions },
    });

    return { data: result };
  },

  async uploadAttachment(ctx: Context) {
    // koa-body puts multipart files under ctx.request.files
    // The field name from the client determines the key (e.g. "file" or "files")
    const allFiles = (ctx.request as any).files || {};

    const file = allFiles.file || allFiles.files;

    if (!file) return ctx.badRequest('No file provided. Send as multipart form field "file".');

    // Normalize to single file (take first if array)
    const uploadFile = Array.isArray(file) ? file[0] : file;

    if (!uploadFile?.filepath) {
      return ctx.badRequest('Invalid file upload — missing file path.');
    }

    try {
      const uploaded = await strapi.plugin('upload').service('upload').upload({
        data: {},
        files: uploadFile,
      });

      const result = Array.isArray(uploaded) ? uploaded[0] : uploaded;

      ctx.status = 201;
      return {
        data: {
          id: result.id,
          url: result.url,
          name: result.name,
        },
      };
    } catch (err: any) {
      strapi.log.error(`[comment] uploadAttachment error: ${err.message}`);
      ctx.status = 500;
      return { error: `Upload failed: ${err.message}` };
    }
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;

    const existing = await strapi.documents(UID).findOne({ documentId: id });
    if (!existing) return ctx.notFound('Comment not found');

    // Only comment author (or API key users) can delete
    const currentUser = ctx.state.user?.username;
    if (currentUser && existing.author && existing.author !== currentUser) {
      return ctx.forbidden('You can only delete your own comments');
    }

    await strapi.documents(UID).delete({ documentId: id });
    ctx.status = 204;
    return null;
  },
}));
