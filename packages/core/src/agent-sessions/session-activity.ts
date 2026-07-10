import { safeRecordActivity } from '../pipeline/activity.js';

export function extractIssueId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).issueId;
  if (typeof raw !== 'string') return null;
  // RFC 4122 UUID — guard against malformed metadata to avoid FK errors
  // even though safeRecordActivity would swallow them.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return null;
  return raw;
}

/**
 * Best-effort `agent-session.created` audit shared by every session-creating
 * handler. activity_log requires an issue FK, so this only records when the
 * session's metadata carries a valid issueId; safeRecordActivity swallows
 * errors.
 */
export async function recordSessionCreatedActivity(
  session: { id: string; title: string | null; metadata: unknown },
  userId: string,
): Promise<void> {
  const auditIssueId = extractIssueId(session.metadata);
  if (!auditIssueId) return;
  await safeRecordActivity({
    issueId: auditIssueId,
    actor: { type: 'user', id: userId },
    action: 'agent-session.created',
    payload: { sessionId: session.id, title: session.title ?? null },
  });
}
