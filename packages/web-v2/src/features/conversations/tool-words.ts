// What a room's assistant did with a tool, said in a person's words: the act and what it acted on.
//
// A room is read by the people in it, not by whoever built the tool, so its cards say "Filed ISS-12 —
// Invoice footer typo" rather than a tool's stored name over "Object · 3 fields", and a refused call
// says why in one line (ISS-1229 r34, judge-93). The stored name, the arguments and the raw result stay
// under the card's technical details. The run thread keeps its own technical cards.

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import type { ToolCallData } from "@/features/session/types";

export interface ToolWords {
  /** The one line the card leads with, in the tense the call is in. */
  said: string;
  /** For a refused call, the refusal's own reason in one short line. */
  refusal?: string;
}

/** How long the refusal's line may run before it is shortened. */
const REASON_CHARS = 120;

interface Act {
  done: string;
  refused: string;
  running: string;
}

const act = (done: string, base: string, running: string, target = ""): Act => {
  const on = target ? ` ${target}` : "";
  return { done: `${done}${on}`, refused: `Couldn't ${base}${on}`, running: `${running}${on}…` };
};

const quoted = (text: string) => `“${text}”`;

/** The value after a flag, as in `--search coolify`. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** The arguments that are neither a flag nor a flag's value, after the verb (and its sub-verb, if given). */
function positionals(argv: readonly string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-") && a !== "-") {
      if (!a.includes("=") && argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("-")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const ISSUE_KEY = /^(?:ISS-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function statusLabel(status: string): string {
  return (ISSUE_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** What the `forge` CLI did, read off its arguments. */
function forgeAct(argv: readonly string[]): Act {
  const [verb, sub] = argv;
  if (argv.includes("-h") || argv.includes("--help")) return act("Read", "read", "Reading", "the tracker's help");
  const keys = positionals(argv, 1).filter((a) => ISSUE_KEY.test(a));
  const key = keys[0];
  switch (verb) {
    case "issue": {
      const search = flag(argv, "--search");
      if (search) return act("Searched", "search", "Searching", `issues for ${quoted(search)}`);
      const status = flag(argv, "--status");
      if (status) return act("Listed", "list", "Listing", `issues at ${statusLabel(status)}`);
      if (key) return act("Read", "read", "Reading", key);
      return act("Listed", "list", "Listing", "issues");
    }
    case "new": {
      const title = flag(argv, "--title");
      return act("Filed", "file", "Filing", title ? quoted(title) : "an issue");
    }
    case "comment": {
      const writes = positionals(argv, 1).some((a) => !ISSUE_KEY.test(a));
      const on = key ?? "an issue";
      return writes ? act("Commented on", "comment on", "Commenting on", on) : act("Read", "read", "Reading", `the comments on ${on}`);
    }
    case "attach":
      return act("Attached", "attach", "Attaching", `a file to ${key ?? "an issue"}`);
    case "next":
      return act("Read", "read", "Reading", "what to work on next");
    case "spec":
      return act("Read", "read", "Reading", key ? `the spec of ${key}` : "the spec");
    case "guide": {
      const slug = positionals(argv, 1)[0];
      return slug ? act("Read", "read", "Reading", `the ${quoted(slug)} guide`) : act("Listed", "list", "Listing", "the guides");
    }
    case "project":
      return act("Read", "read", "Reading", "the project");
    case "knowledge":
      return knowledgeAct(sub, flag(argv, "--query") ?? positionals(argv, 2)[0]);
    default:
      return act("Used", "use", "Using", "the tracker");
  }
}

function knowledgeAct(action: unknown, subject: unknown): Act {
  const what = typeof subject === "string" && subject.trim() ? subject.trim() : undefined;
  if (action === "search") {
    return act("Searched", "search", "Searching", `project knowledge${what ? ` for ${quoted(what)}` : ""}`);
  }
  if (action === "get") return act("Read", "read", "Reading", what ? `${quoted(what)} from project knowledge` : "project knowledge");
  return act("Listed", "list", "Listing", "project knowledge");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The act a tool the room's assistant holds stands for; `null` for one the room has no words for. */
function actOf(tool: ToolCallData): Act | null {
  const input = tool.input ?? {};
  switch (tool.name) {
    case "forge": {
      const argv = Array.isArray(input.argv) ? input.argv.filter((a): a is string => typeof a === "string") : [];
      return forgeAct(argv);
    }
    case "forge_knowledge":
      return knowledgeAct(input.action, input.query ?? input.slug);
    case "forge_memory_search": {
      const q = str(input.query);
      return act("Searched", "search", "Searching", `project memory${q ? ` for ${quoted(q)}` : ""}`);
    }
    case "forge_guide": {
      const slug = str(input.slug);
      return input.action === "get" && slug
        ? act("Read", "read", "Reading", `the ${quoted(slug)} guide`)
        : act("Listed", "list", "Listing", "the guides");
    }
    case "forge_projects_get":
      return act("Read", "read", "Reading", "the project");
    case "forge_pipeline_runs_get":
      return act("Read", "read", "Reading", "the project's pipeline runs");
    case "forge_project_pipeline_runs":
      switch (input.action) {
        case "get":
          return act("Read", "read", "Reading", "a pipeline run");
        case "pause":
          return act("Paused", "pause", "Pausing", "a pipeline run");
        case "resume":
          return act("Resumed", "resume", "Resuming", "a pipeline run");
        case "cancel":
          return act("Cancelled", "cancel", "Cancelling", "a pipeline run");
        default:
          return act("Listed", "list", "Listing", "the pipeline runs");
      }
    case "forge_metrics_project_step_durations":
      return act("Read", "read", "Reading", "how long the pipeline's steps take");
    case "forge_metrics_project_timeseries":
      return act("Read", "read", "Reading", "the project's activity over time");
    case "forge_preferences":
      return act("Saved", "save", "Saving", "how you want to be answered");
    case "forge_memory_note": {
      const title = str(input.title);
      return title
        ? act("Noted", "note", "Noting", `${quoted(title)} in project memory`)
        : act("Added", "add", "Adding", "a note to project memory");
    }
    default:
      return null;
  }
}

/** How many came back, where the result says it plainly. */
function foundCount(tool: ToolCallData): number | null {
  const result = tool.result;
  if (result == null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (tool.name === "forge") {
    const argv = Array.isArray(tool.input?.argv) ? (tool.input?.argv as unknown[]) : [];
    if (argv[0] !== "issue" || typeof r.stdout !== "string") return null;
    if (argv.some((a) => typeof a === "string" && ISSUE_KEY.test(a))) return null;
    const m = /(\d+) issue\(s\)/.exec(r.stdout);
    return m ? Number(m[1]) : null;
  }
  if (tool.name === "forge_memory_search" && Array.isArray(r.hits)) return r.hits.length;
  if (tool.name === "forge_knowledge" && tool.input?.action === "search") {
    const k = Array.isArray(r.knowledge) ? r.knowledge.length : 0;
    const m = Array.isArray(r.memory) ? r.memory.length : 0;
    return Array.isArray(r.knowledge) || Array.isArray(r.memory) ? k + m : null;
  }
  return null;
}

/** The issue a successful `forge new` filed, read off its reply. */
function filedKey(tool: ToolCallData): string | null {
  const r = tool.result as { stdout?: unknown } | null | undefined;
  const out = r && typeof r === "object" && typeof r.stdout === "string" ? r.stdout : "";
  return /"issueId"\s*:\s*"([^"]+)"/.exec(out)?.[1] ?? null;
}

/** The refusal's reason: the first sentence of what the tool said, one line. */
export function refusalReason(result: unknown): string {
  let text = "";
  if (typeof result === "string") text = result;
  else if (result != null && typeof result === "object") {
    const r = result as { stderr?: unknown; message?: unknown; stdout?: unknown };
    text = [r.stderr, r.message, r.stdout].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "";
  }
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "It gave no reason.";
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > REASON_CHARS ? `${sentence.slice(0, REASON_CHARS).trimEnd()}…` : sentence;
}

/** What the call did, in the tense it is in, and why it was refused where it was. */
export function toolWords(tool: ToolCallData, live = false): ToolWords {
  const a = actOf(tool) ?? { done: "Used a tool", refused: "Couldn't use a tool", running: "Using a tool…" };
  if (tool.isError === true) return { said: a.refused, refusal: refusalReason(tool.result) };
  if (tool.result === undefined && live) return { said: a.running };
  if (tool.name === "forge" && tool.input?.argv && (tool.input.argv as unknown[])[0] === "new") {
    const key = filedKey(tool);
    const title = flag((tool.input.argv as unknown[]).filter((x): x is string => typeof x === "string"), "--title");
    if (key) return { said: title ? `Filed ${key} — ${title}` : `Filed ${key}` };
  }
  const n = foundCount(tool);
  return { said: n === null ? a.done : `${a.done} — ${n === 0 ? "none found" : `${n} found`}` };
}
