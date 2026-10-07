// Words that are English chrome and have a Vietnamese word in the locale file. A screen rendered in vi
// that still shows one of them has a string that never went through the locale file; a sentence core
// said, read in vi, that still holds one has a vi template that was never written. Brand and product
// terms the vi copy keeps (Release, Workflow, Issue, Runner, Master) are not on the list.
export const ENGLISH_CHROME = [
  "needs you", "nothing", "waiting", "lands", "late", "progress", "requirements", "untriaged", "overview", "dashboard", "settings",
  "sign out", "next release", "open full page", "show", "hide", "close", "cancel", "loading", "failed", "couldn't", "no ", "search",
  "waits on", "then", "forecast", "landed", "shipped", "feedback about",
  "release train", "coming next", "approve", "return", "criteria", "proven", "maintenance", "what users get", "technical", "notes", "checks", "issues in this release",
  "cut", "approval", "decision", "policy", "environment", "deploy", "passed", "details", "reason", "designs", "diagram", "steps",
  "states", "owner", "deadline", "revisions", "decisions", "health", "updated", "all", "walk through", "zoom", "fit", "minimap",
  "legend", "stage", "next", "back", "finish", "system overview", "main journey", "users", "external systems", "where it stands", "properties", "template",
  "drawn by", "the code", "trace", "if", "who owns what", "newest first", "proposal", "coverage", "summary", "scope", "accept", "reject",
  "defer", "drop", "created", "suggestions", "activity", "evidence", "persona", "wording", "assistant", "pending", "promote", "retry",
  "step", "ago", "feedback", "triage", "funnel", "reporter", "reporters", "decline", "snooze", "reopen", "severity", "carried by",
  "sent", "message", "internal note", "preview", "history", "mockups", "route it", "unknown", "flagged", "description", "answered", "confirm",
  "what happened", "move it", "why", "status", "state", "sensitive", "clarification", "verifies", "duplicate of", "original", "until", "subject",
  "attention", "back to", "group by", "facts", "lifecycle", "optional", "add note", "send", "suggested",
  "account", "preferences", "profile", "theme", "notifications", "conversation", "conversations", "chat", "pin", "unpin", "archive",
  "archived", "delete", "rename", "copy", "workspace", "projects", "switch", "find", "organization", "docs", "threads", "ecosystem",
  "home", "more", "navigate", "actions", "recent", "pinned", "no matches", "resolved", "invitation", "mention", "sound", "desktop",
  "save", "restore", "reply style", "instructions", "upload", "sketch", "caption", "withdraw", "authority", "options considered",
  "rollback", "removed", "release note", "gate", "verdict", "owes", "held back", "sidebar", "people", "live", "not found", "add project",
  "priority", "assignee", "board", "wave", "blocked", "blocking", "queued", "running", "paused", "resume", "merged", "branch", "comment",
  "comments", "runs", "open", "closed", "on hold", "move", "mark", "labels", "complexity", "category", "cost", "tokens", "dependencies",
  "selected", "clear", "filter", "sort", "newest", "oldest", "previous", "heartbeat", "stale", "attempt", "cooldown", "answer", "question",
  "who", "build", "plan", "estimated", "critical", "high", "medium", "low", "bug", "lease", "nobody", "everyone", "list", "table",
  "spend", "online", "offline", "busy", "idle", "draining", "modules", "signals", "contracts", "slots", "holder", "since", "backlog",
  "finished", "silent", "alive", "jobs", "median", "unclassified", "reopened", "dropped", "welcome", "personal", "quiet", "flow",
  "window", "healthy", "select all", "in flight", "trailing", "chart", "today", "never", "oldest", "machine", "scope", "not on",
  "device", "devices", "paired", "pair", "revoke", "manage", "turn on", "turn off", "last seen", "provision", "labels", "pool",
  "resident", "unassign", "copy", "repo path", "disk", "binaries", "missing", "version", "drained", "retired", "mine", "organisation",
  "counting", "read only", "unknown device", "untitled", "remove", "heartbeat", "failed pool", "rate limited", "usage limit", "next try", "refused",
  "connection", "connections", "connected", "not connected", "credential", "integration", "integrations", "binding", "rotate", "disconnect",
  "connect", "refresh", "configuration", "repository", "verify", "grant", "granted", "storefront", "room", "rooms", "site", "target",
  "targets", "deliveries", "payload", "response", "enabled", "disabled", "inherited", "danger zone", "test connection", "store", "themes",
  "commerce", "scopes", "access token", "refresh token", "api key", "server url", "base url", "project path", "secret token",
  "trigger", "share", "will inject", "shadowed", "untested", "breaker", "application", "deploy target", "delivered", "inbound", "outbound",
  "organizations", "members", "member", "slug", "expired", "role", "agents", "handle", "soul", "greeting", "glyph", "standing instructions",
  "dormant", "permissions", "expires", "last used", "prefix", "full access", "endpoint", "snippet", "client", "done", "revoked", "you",
  "required", "quick capture", "capture", "attach", "context", "description", "optional", "choose files", "summary",
  "recommended", "choose", "needed", "round", "rounds", "earlier", "chosen", "withdrawn", "unanswered", "decision waiting", "your answer", "still waits",
  "schedule", "schedules", "fires", "fired", "sessions", "turns", "duration", "started", "stalled", "abort", "owns", "silence",
  "participants", "what the agent sees", "add agent", "add person", "skills", "plugins", "pinned ref", "not declared", "blockers", "warnings",
];


/** The English chrome word `text` carries, or null. A snake_case value (`in_progress`), a dotted
 *  permission (`workflow-designs.approve`, `feedback.approve`), a field in code quotes (`persona`) or a
 *  path segment (`/srv/device`) is an identifier the text names on purpose, not chrome. */
export function englishChromeWord(text: string): string | null {
  const lower = ` ${text.toLowerCase()} `;
  for (const w of ENGLISH_CHROME) {
    if (new RegExp(`[^\\p{L}_.\`/-]${w.trim()}(?![\\p{L}_\`/]|\\.\\p{L})`, "u").test(lower)) return w.trim();
  }
  return null;
}
