const SESSION_UID = 'api::agent-session.agent-session' as any;

const JUNK_RESPONSE_PATTERN = /high traffic|try again in a minute|429|529|overloaded/i;
const MAX_JUNK_LENGTH = 200;

function isEmptySession(messages: any[]): boolean {
  if (messages.length === 0) return true;
  const assistantMsgs = messages.filter((m: any) => m.role === 'assistant');
  if (assistantMsgs.length === 0) return true;
  return assistantMsgs.every((m: any) => {
    const content = (m.content || '').trim();
    return content.length < MAX_JUNK_LENGTH && JUNK_RESPONSE_PATTERN.test(content);
  });
}

/**
 * Delete completed AG sessions with no useful work — either no assistant
 * response at all, or only short high-traffic error responses.
 * Only checks the 500 most recently created completed sessions.
 */
export async function cleanupEmptyCompletedSessions(strapi: any): Promise<number> {
  const sessions = await strapi.documents(SESSION_UID).findMany({
    filters: { status: 'completed' },
    fields: ['documentId', 'messages'],
    sort: 'createdAt:desc',
    limit: 500,
  });

  let deleted = 0;
  for (const session of sessions) {
    const messages: any[] = Array.isArray(session.messages) ? session.messages : [];
    if (isEmptySession(messages)) {
      await strapi.documents(SESSION_UID).delete({ documentId: session.documentId });
      deleted++;
    }
  }

  return deleted;
}
