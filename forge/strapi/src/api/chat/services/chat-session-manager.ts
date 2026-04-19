/**
 * Load or create a chat session.
 */
export async function loadOrCreateSession(strapi: any, sessionId: string | undefined, message: string, project: any, userDocumentId?: string, source: string = 'web', widgetUserId?: string): Promise<any> {
  let session: any;
  if (sessionId) {
    session = await strapi.documents('api::chat-session.chat-session').findOne({
      documentId: sessionId,
    });
  }
  if (!session) {
    session = await strapi.documents('api::chat-session.chat-session').create({
      data: {
        title: message.slice(0, 80),
        messages: [],
        metadata: {},
        source,
        project: { documentId: project.documentId },
        ...(userDocumentId ? { user: { documentId: userDocumentId } } : {}),
        ...(widgetUserId ? { widgetUserId } : {}),
      },
    });
  }
  return session;
}

/**
 * Persist updated messages and metadata to the session.
 */
export async function persistSession(strapi: any, sessionDocumentId: string, messages: any[], metadata: any) {
  await strapi.documents('api::chat-session.chat-session').update({
    documentId: sessionDocumentId,
    data: { messages: messages as any, metadata },
  });
}
