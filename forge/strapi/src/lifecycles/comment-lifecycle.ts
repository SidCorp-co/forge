import { upsertEmbedding, removeEmbeddings, sanitizeContent } from '../services/embeddings';
import { createActivity } from './issue-lifecycle';

const NOTIFICATION_UID = 'api::notification.notification' as const;

export function subscribeCommentLifecycles(strapi: any) {
  strapi.db.lifecycles.subscribe({
    models: ['api::comment.comment'],

    async afterCreate(event: any) {
      const { result } = event;

      setImmediate(async () => {
        try {
          const comment = await strapi.documents('api::comment.comment').findOne({
            documentId: result.documentId,
            populate: ['issue', 'attachments'],
          });
          if (!comment?.issue?.documentId) return;

          const metadata: Record<string, any> = { commentDocumentId: comment.documentId };
          if (comment.attachments?.length) {
            metadata.attachments = comment.attachments.map((a: any) => ({
              id: a.id, url: a.url, name: a.name, mime: a.mime,
            }));
          }

          await Promise.all([
            createActivity(strapi, {
              type: 'comment',
              issue: comment.issue.documentId,
              actor: comment.author || 'system',
              body: comment.body,
              isAI: comment.isAI || false,
              metadata,
            }),
            embedAndNotify(strapi, comment, true),
          ]);
        } catch (err: any) {
          strapi.log.warn(`[comment-lifecycle] afterCreate: ${err.message}`);
        }
      });
    },

    async afterUpdate(event: any) {
      const { result } = event;

      setImmediate(async () => {
        try {
          const comment = await strapi.documents('api::comment.comment').findOne({
            documentId: result.documentId,
            populate: ['issue'],
          });
          if (!comment?.issue?.documentId) return;

          // Sync activity body so the timeline shows the latest comment content
          await syncActivityBody(strapi, comment);

          // Re-embed on update, skip mention notifications to avoid duplicates
          await embedAndNotify(strapi, comment, false);
        } catch (err: any) {
          strapi.log.warn(`[comment-lifecycle] afterUpdate: ${err.message}`);
        }
      });
    },

    async afterDelete(event: any) {
      const { result } = event;
      if (result?.documentId) {
        setImmediate(() => {
          removeEmbeddings('comment', result.documentId).catch((err: any) =>
            strapi.log.warn(`[embed] comment delete: ${err.message}`));
        });
      }
    },
  });
}


/** Update the matching activity record when a comment body changes */
async function syncActivityBody(strapi: any, comment: any) {
  try {
    // Find activity by commentDocumentId in metadata (use $containsi for JSON string match)
    const activities = await strapi.db.query('api::activity.activity').findMany({
      where: {
        type: 'comment',
        metadata: { $containsi: comment.documentId },
      },
      select: ['id', 'documentId', 'metadata'],
      limit: 10,
    });
    // Filter to exact commentDocumentId match
    const matched = activities.filter((a: any) => a.metadata?.commentDocumentId === comment.documentId);

    if (matched.length > 0) {
      await strapi.documents('api::activity.activity').update({
        documentId: matched[0].documentId,
        data: { body: comment.body },
      });
    }
  } catch (err: any) {
    strapi.log.warn(`[comment-lifecycle] syncActivityBody: ${err.message}`);
  }
}

/** Embed comment and optionally create mention notifications */
async function embedAndNotify(strapi: any, comment: any, notify: boolean) {
  const issueDocId = comment.issue?.documentId;
  if (!issueDocId) return;

  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocId,
    populate: ['project'],
  });
  if (!issue?.project?.documentId) return;

  await upsertEmbedding({
    project_id: issue.project.documentId,
    source_type: 'comment',
    source_id: comment.documentId,
    text: sanitizeContent(`[${issue.title}] ${comment.body || ''}`),
    metadata: {
      issueTitle: issue.title,
      issueDocumentId: issue.documentId,
      issueStatus: issue.status,
      issueCategory: issue.category,
      author: comment.author,
      updatedAt: new Date().toISOString(),
    },
    contextual: true,
  });

  if (notify) {
    await createMentionNotifications(strapi, comment, issue);
  }
}

/** Create notifications for each @mentioned user */
async function createMentionNotifications(strapi: any, comment: any, issue: any) {
  const mentions: string[] = comment.mentions || [];
  if (mentions.length === 0) return;

  const author = comment.author || 'Someone';
  const issueTitle = issue.title || 'an issue';

  await Promise.all(mentions.map(async (username) => {
    try {
      await strapi.documents(NOTIFICATION_UID).create({
        data: {
          type: 'mention',
          title: `${author} mentioned you in ${issueTitle}`,
          body: comment.body?.slice(0, 200) || '',
          issueDocumentId: issue.documentId,
          project: issue.project?.documentId || null,
        },
      });
    } catch (err: any) {
      strapi.log.warn(`[comment-lifecycle] mention notification for @${username}: ${err.message}`);
    }
  }));
}
