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
/** Kernel floor for chat-created issues — a hollow one-liner is rejected so
 *  the model rewrites it within the same turn (tool-error feedback loop). */
const MIN_TITLE_CHARS = 10;
const MIN_DESCRIPTION_CHARS = 200;

export function guardIssueWrites(args: Record<string, unknown>): string | null {
  const action = args.action;
  const data = (args.data ?? {}) as Record<string, unknown>;
  if (action === 'create') {
    data.status = 'draft';
    args.data = data;
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    if (title.length < MIN_TITLE_CHARS || description.length < MIN_DESCRIPTION_CHARS) {
      return (
        'issue rejected: too thin to be actionable. A developer must be able to identify the problem WITHOUT reading the chat. Rewrite and call create again with: ' +
        '(1) a title naming the kind + affected feature (e.g. "[Bug] …"), ' +
        '(2) a description with the problem or request in concrete detail — what happens, where, expected vs actual, quoting the reporter where useful — plus the source links from the context (the external task/feedback URL if one exists, and the chat permalink).'
      );
    }
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
