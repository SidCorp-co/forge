import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams } from '../../../services/query-params';

const UID = 'api::activity.activity' as any;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    const results = await strapi.documents(UID).findMany(params);

    // Enrich comment activities with attachment data from source comments
    const commentActivities = results.filter(
      (a: any) => a.type === 'comment' && a.metadata?.commentDocumentId && !a.metadata?.attachments?.length,
    );
    if (commentActivities.length > 0) {
      const commentDocs = await strapi.documents('api::comment.comment' as any).findMany({
        filters: { documentId: { $in: commentActivities.map((a: any) => a.metadata.commentDocumentId) } },
        populate: ['attachments'],
      });
      const commentMap = new Map(commentDocs.map((c: any) => [c.documentId, c]));
      for (const act of commentActivities) {
        const comment = commentMap.get((act as any).metadata.commentDocumentId);
        if (comment?.attachments?.length) {
          (act as any).metadata = {
            ...(act as any).metadata,
            attachments: comment.attachments.map((a: any) => ({
              id: a.id, url: a.url, name: a.name, mime: a.mime,
            })),
          };
        }
      }
    }

    return { data: results };
  },

  /**
   * PUT /activities/:documentId/evaluate
   * Body: { verdict: 'approve' | 'reject', note?: string }
   *
   * Records user evaluation of a Pikachu shadow decision.
   * Updates the activity's metadata with the eval result.
   */
  async evaluate(ctx: Context) {
    const { documentId } = ctx.params as { documentId: string };
    const { verdict, note } = (ctx.request as any).body || {};

    if (!verdict || !['approve', 'reject'].includes(verdict)) {
      return ctx.badRequest('verdict must be "approve" or "reject"');
    }

    const activity = await strapi.documents(UID).findOne({ documentId });
    if (!activity) return ctx.notFound('Activity not found');
    if (activity.type !== 'pikachu_decision') {
      return ctx.badRequest('Can only evaluate pikachu_decision activities');
    }

    const metadata = (activity.metadata as any) || {};
    metadata.eval = {
      verdict,
      note: note || undefined,
      at: new Date().toISOString(),
    };

    await strapi.documents(UID).update({
      documentId,
      data: { metadata } as any,
    });

    // Also update Qdrant outcome if sourceId exists
    const sourceId = metadata.decision?.sourceId;
    if (sourceId) {
      setImmediate(async () => {
        try {
          const { recordPikachuOutcome } = await import('../../../services/pikachu');
          await recordPikachuOutcome(strapi, sourceId, verdict === 'approve' ? 'success' : 'failed', note);
        } catch { /* silent */ }
      });
    }

    return { data: { documentId, verdict } };
  },

  /**
   * DELETE /activities/:documentId
   * Deletes a single activity. Only low-value types are deletable.
   */
  async delete(ctx: Context) {
    const { documentId } = ctx.params as { documentId: string };

    const activity = await strapi.documents(UID).findOne({ documentId });
    if (!activity) return ctx.notFound('Activity not found');

    const DELETABLE_TYPES = [
      'comment',
      'status_change', 'priority_change', 'category_change',
      'title_change', 'label_added', 'label_removed',
      'enriched', 'agent_session', 'relation_added', 'relation_removed',
    ];

    if (!DELETABLE_TYPES.includes(activity.type)) {
      return ctx.badRequest(`Cannot delete activities of type "${activity.type}"`);
    }

    // Delete the source comment too if this is a comment activity
    if (activity.type === 'comment') {
      const commentDocId = (activity.metadata as any)?.commentDocumentId;
      if (commentDocId) {
        try {
          await strapi.documents('api::comment.comment' as any).delete({ documentId: commentDocId });
        } catch { /* source comment may already be gone */ }
      }
    }

    await strapi.documents(UID).delete({ documentId });
    return { data: { documentId, deleted: true } };
  },
}));
