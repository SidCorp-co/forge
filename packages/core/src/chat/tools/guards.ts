/**
 * ISS-609 — pure arg-guards for the chat tool allowlist. Kept dependency-free
 * (no MCP/db imports) so they unit-test without booting env.
 */

/**
 * Statuses chat may set on an issue. Everything else is rejected: every status
 * in the pipeline registry (`open`/`confirmed`/`clarified`/`approved`/
 * `developed`/`reopen`/`testing`/`released`) dispatches a job the moment the
 * transition lands, and `in_progress`/`tested` are agent-/human-owned gate
 * states. Kept as an explicit allowlist (not a registry-derived blocklist) so
 * a newly added pipeline stage is closed to chat by default.
 */
const CHAT_SETTABLE_STATUSES = new Set(['draft', 'waiting', 'needs_info', 'on_hold', 'closed']);

/**
 * Draft-first issue guard: a chat-created issue always enters as `draft`, and
 * a chat update may only move an issue between the non-dispatching statuses
 * above — any pipeline-engaging transition (and the `unblock` operator escape
 * hatch) is a human's call. The bot answers whoever @-mentions it in the room,
 * so this is the hard fence against a prompt-injected dispatch.
 */
export function guardIssueWrites(args: Record<string, unknown>): string | null {
  const action = args.action;
  const data = (args.data ?? {}) as Record<string, unknown>;
  if (action === 'create') {
    data.status = 'draft';
    args.data = data;
    return null;
  }
  if (action === 'update') {
    if (data.unblock !== undefined) {
      return "chat must not use 'unblock' — it re-engages a pipeline an operator put on hold; ask a human to resume the issue";
    }
    if (data.status !== undefined && !CHAT_SETTABLE_STATUSES.has(data.status as string)) {
      return `chat may only set an issue's status to ${[...CHAT_SETTABLE_STATUSES].join('/')} — '${String(
        data.status,
      )}' would dispatch a pipeline job; leave that transition to a human`;
    }
  }
  return null;
}
