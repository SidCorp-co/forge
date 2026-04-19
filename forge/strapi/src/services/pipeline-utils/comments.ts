/**
 * Pipeline comment helpers.
 */

/**
 * Post a pipeline system comment on an issue.
 * Used for failure notifications and loop protection alerts.
 */
export async function postPipelineComment(
  strapi: any,
  issueDocumentId: string,
  body: string,
  author: string,
): Promise<void> {
  try {
    await strapi.documents('api::comment.comment').create({
      data: {
        body,
        author,
        isAI: true,
        issue: { documentId: issueDocumentId },
      },
    });
  } catch (err: any) {
    strapi.log.warn(`[pipeline] Failed to post comment on ${issueDocumentId}: ${err.message}`);
  }
}
