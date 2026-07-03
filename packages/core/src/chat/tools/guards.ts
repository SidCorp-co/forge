/**
 * ISS-609 — pure arg-guards for the chat tool allowlist. Kept dependency-free
 * (no MCP/db imports) so they unit-test without booting env.
 */

/**
 * Draft-first issue guard: a chat-created issue always enters as `draft`
 * (never `open` — that would immediately dispatch a pipeline run), and chat
 * may not flip an existing issue to `open` either; a human does that.
 */
export function guardIssueWrites(args: Record<string, unknown>): string | null {
  const action = args.action;
  const data = (args.data ?? {}) as Record<string, unknown>;
  if (action === 'create') {
    data.status = 'draft';
    args.data = data;
    return null;
  }
  if (action === 'update' && data.status === 'open') {
    return "chat must not set an issue to 'open' (it would dispatch a pipeline run) — leave it 'draft' and ask a human to open it";
  }
  return null;
}
