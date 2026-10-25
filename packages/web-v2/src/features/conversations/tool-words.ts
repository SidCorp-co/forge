// What a room's assistant did with a tool, said in a person's words: the act and what it acted on.
//
// A room is read by the people in it, not by whoever built the tool, so its cards say "Filed ISS-12 —
// Invoice footer typo" rather than a tool's stored name over "Object · 3 fields", and a refused call
// says why in one line (ISS-1229 r34, judge-93). The stored name, the arguments and the raw result stay
// under the card's technical details. The run thread keeps its own technical cards.

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import { roomOpens, whereItIsDone } from "@forge/contracts/room-verbs";
import type { ToolCallData } from "@/features/session/types";

export interface ToolWords {
  /** The one line the card leads with, in the tense the call is in. */
  said: string;
  /** For a refused call, the refusal's own reason in one short line. */
  refusal?: string;
}

/** How long the refusal's line runs before it takes fewer of its whole sentences; it never cuts one. */
const REASON_CHARS = 120;

interface Act {
  done: string;
  refused: string;
  running: string;
  kind: string;
  on: string;
}

const act = (done: string, base: string, running: string, target = ""): Act => {
  const on = target ? ` ${target}` : "";
  return { done: `${done}${on}`, refused: `Couldn't ${base}${on}`, running: `${running}${on}…`, kind: base, on: target };
};

const quoted = (text: string) => `“${text}”`;

/** The value after a flag, as in `--search coolify`. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** Every value given a repeatable flag, as in `--set status=x --set priority=y`. */
function flags(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--") ? [argv[i + 1] as string] : []));
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

/** Whether a `forge comment` writes one: it names something beside the issue, such as `-` for its body. */
const commentWrites = (argv: readonly string[]) => positionals(argv, 1).some((a) => !ISSUE_KEY.test(a));

/** A move to another status, or any other change to an issue, named for what it tried (ISS-1229 r39, judge-107). */
function changeAct(key: string, status: string | undefined): Act {
  return status
    ? act("Moved", "move", "Moving", `${key} to ${statusLabel(status)}`)
    : act("Updated", "update", "Updating", key);
}

const CHANGE_FLAGS = ["--set", "--blocks", "--relates", "--unlink"];

/** What the `forge` CLI did, read off its arguments. */
function forgeAct(argv: readonly string[]): Act {
  const [verb, sub] = argv;
  if (argv.includes("-h") || argv.includes("--help")) return { ...act("Read", "read", "Reading", "the tracker's help"), kind: "help" };
  const keys = positionals(argv, 1).filter((a) => ISSUE_KEY.test(a));
  const key = keys[0];
  switch (verb) {
    case "advance": {
      const to = flag(argv, "--set");
      return to ? changeAct(key ?? "an issue", to) : act("Moved", "move", "Moving", `${key ?? "an issue"} to its next status`);
    }
    case "issue": {
      if (key && CHANGE_FLAGS.some((f) => argv.includes(f))) {
        const status = flags(argv, "--set").find((v) => v.startsWith("status="));
        return changeAct(key, status?.slice("status=".length));
      }
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
      const on = key ?? "an issue";
      return commentWrites(argv) ? act("Commented on", "comment on", "Commenting on", on) : act("Read", "read", "Reading", `the comments on ${on}`);
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
      return knowledgeAct(sub, flag(argv, "--query") ?? positionals(argv, 2)[0], flag(argv, "--scope"));
    default:
      return act("Used", "use", "Using", "the tracker");
  }
}

/** Which stores a knowledge search reads: knowledge alone unless its scope names memory or both. */
type SearchScope = "knowledge" | "memory" | "all";
const searchScope = (scope: unknown): SearchScope => (scope === "memory" || scope === "all" ? scope : "knowledge");
const SCOPE_WORDS: Record<SearchScope, string> = {
  knowledge: "project knowledge",
  memory: "project memory",
  all: "project knowledge and memory",
};

function knowledgeAct(action: unknown, subject: unknown, scope?: unknown): Act {
  const what = typeof subject === "string" && subject.trim() ? subject.trim() : undefined;
  if (action === "search") {
    return act("Searched", "search", "Searching", `${SCOPE_WORDS[searchScope(scope)]}${what ? ` for ${quoted(what)}` : ""}`);
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
      return knowledgeAct(input.action, input.query ?? input.slug, input.scope);
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

/** What a count reads as after the act: "none found", "2 found", or each store's own count. */
type Found = number | { knowledge: number; memory: number };

const counted = (n: number, where?: string) => `${n === 0 ? "none" : n}${where ? ` in ${where}` : " found"}`;

function foundWords(found: Found): string {
  if (typeof found === "number") return counted(found);
  if (found.knowledge + found.memory === 0) return "none found";
  return `${counted(found.knowledge, "knowledge")}, ${counted(found.memory, "memory")}`;
}

/** How many came back, where the result says it plainly; a search of both stores counts each apart (r35). */
function foundCount(tool: ToolCallData): Found | null {
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
    if (!Array.isArray(r.knowledge) && !Array.isArray(r.memory)) return null;
    const k = Array.isArray(r.knowledge) ? r.knowledge.length : 0;
    const m = Array.isArray(r.memory) ? r.memory.length : 0;
    const scope = searchScope(tool.input.scope);
    return scope === "all" ? { knowledge: k, memory: m } : scope === "memory" ? m : k;
  }
  return null;
}

/** The issue a successful `forge new` filed, read off its reply. */
function filedKey(tool: ToolCallData): string | null {
  const r = tool.result as { stdout?: unknown } | null | undefined;
  const out = r && typeof r === "object" && typeof r.stdout === "string" ? r.stdout : "";
  return /"issueId"\s*:\s*"([^"]+)"/.exec(out)?.[1] ?? null;
}

/** A paragraph's sentences, wherever its lines break. */
const sentencesOf = (paragraph: string) =>
  paragraph
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * A sentence written for the agent rather than the person reading the room: it names a command, a flag
 * or terminal output, none of which a person in a room can type or see (ISS-1229 r37, judge-100).
 */
const FOR_THE_AGENT =
  /`(?:forge[\s_]|-)[^`]*`|\b\w+=\w|(?:^|\s)--?[a-z]|\bone per line\b|\b(?:stdout|stderr|exit code|argv)\b/i;

/**
 * The refusals whose way out is the person's, known by what they say went wrong: a key the person
 * named, an act a room does not open, and a tracker that did not answer. Every other refusal is the
 * assistant's own call gone wrong, whatever its suggestion says (ISS-1229 r38, judge-103).
 */
const PERSON_KINDS: readonly { says: RegExp; wrong?: string; remedy: string }[] = [
  {
    says: /\bis not (?:on|in) this project|\bholds no issue\b|\bdoes not exist\b|\bno such issue\b/i,
    remedy: "Check the key, or ask the assistant to list this project's issues.",
  },
  {
    says: /\bis not open from chat\b/i,
    wrong: "The assistant can't do that from a room.",
    remedy: "Here it can read, file and comment on issues.",
  },
  {
    says: /\bstopped after (\d+)s with no answer\b/i,
    wrong: "The tracker did not answer in time.",
    remedy: "Ask the assistant to check whether it went through before trying again.",
  },
];
/** A `forge` command, in backticks or on an indented line, that a room does not open (ISS-1229 r40). */
const NAMED_COMMAND = /`forge ([\w-]+)(?: ([\w-]+))?|^[ \t]+forge ([\w-]+)(?: ([\w-]+))?/gm;

function closedCommand(text: string): string | null {
  for (const m of text.matchAll(NAMED_COMMAND)) {
    const verb = m[1] ?? m[3];
    if (verb && !roomOpens(verb, m[2] ?? m[4])) return verb;
  }
  return null;
}

export const PUT_IT_RIGHT = "Ask the assistant to put it right and try again.";
export const TOOK_ANOTHER_WAY = "The assistant tried another way below, and its answer says how it went.";

/** The CLI verb each tool is another door to: one act, one identity, never matched by spelling (ISS-1229 r39). */
export const DOOR_OF_TOOL: Readonly<Record<string, string>> = {
  forge_guide: "guide",
  forge_knowledge: "knowledge",
  forge_memory_search: "knowledge",
  forge_projects_get: "project",
};

/** The door a call came through, as one name for the CLI verb and the tool that mirrors it. */
function doorOf(tool: ToolCallData): string {
  if (tool.name !== "forge") return DOOR_OF_TOOL[tool.name] ?? tool.name;
  const argv = Array.isArray(tool.input?.argv) ? (tool.input.argv as unknown[]) : [];
  return typeof argv[0] === "string" ? argv[0] : "";
}

/** A call's door, verb and target as the card's own `Act` says them; no target where it names nothing (r38). */
function callOf(tool: ToolCallData): { act: string; target: string | null } {
  const input = tool.input ?? {};
  const said = actOf(tool);
  const act = `${doorOf(tool)} ${said?.kind ?? String(input.action ?? "")}`;
  if (tool.name === "forge" && Array.isArray(input.argv)) {
    const argv = input.argv.filter((a): a is string => typeof a === "string");
    const sub = argv[0] === "knowledge" ? 2 : 1;
    const names = positionals(argv, sub).some((a) => a !== "-") || TARGET_FLAGS.some((f) => flag(argv, f));
    return { act, target: names && said ? said.on : null };
  }
  const names = [input.slug, input.id, input.issueId, input.query].some((v) => typeof v === "string");
  return { act, target: names ? (said?.on ?? JSON.stringify(input)) : null };
}

/** The flags that say what a call acted on: a filing's title, a search's words, a listing's status. */
const TARGET_FLAGS = ["--title", "--search", "--status", "--query"];

/** A refusal saying what the call named does not exist, so only another target could take it further. */
const NAMES_NOTHING = /\bno (?:such|\w+ (?:named|called))\b|\bnot found\b|\bdoes not exist\b|\bunknown\b/i;

/**
 * Whether the assistant tried another way later in the same reply: a later call of the same act went
 * through on the same target, or on another where the refused one named nothing that exists (a guide
 * that is not there, r38). Whether that other target held what was sought is the reply's to say, so the
 * card claims only the attempt.
 */
export function tookAnotherWay(tool: ToolCallData, later: readonly ToolCallData[]): boolean {
  const refused = callOf(tool);
  const anyTarget = NAMES_NOTHING.test(refusalText(tool.result));
  return later.some((t) => {
    if (t.isError === true || t.result === undefined) return false;
    const done = callOf(t);
    return done.act === refused.act && (anyTarget || (refused.target !== null && done.target === refused.target));
  });
}

/** The refusal's own words, off whichever stream carried them. */
function refusalText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null || typeof result !== "object") return "";
  const r = result as { stderr?: unknown; message?: unknown; stdout?: unknown };
  return [r.stderr, r.message, r.stdout].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "";
}

/** A sentence's leading whole clause made a sentence, where the clauses after it only add detail. */
const leadClause = (sentence: string) => {
  const cut = sentence.split(/; |: /)[0] as string;
  return cut === sentence ? sentence : `${cut.replace(/[,;:]$/, "")}.`;
};

/** A tool's own failure prefix ("forge issue failed: "): the technical view's, never reworded (ISS-1229 r39). */
const TOOL_PREFIX = /^(?:forge(?:_\w+)?)(?:\s+[\w-]+)?\s+(?:failed|refused)\s*:\s*/i;
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const listed = (items: readonly string[], last: string) =>
  items.length === 1 ? (items[0] as string) : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;

/** One gap of a refusal that lists them: what it read, what it wants, and the section a clear adds. */
interface Gap {
  read: string;
  wants: string;
  adds: string | null;
}

function gapsOf(text: string): Gap[] {
  return [...text.matchAll(/^\s*- read: (.+)\n\s*wants: (.+)\n\s*clear: (.+)$/gm)].map((m) => ({
    read: (m[1] as string).replace(/, among .*$/, "").trim(),
    wants: (m[2] as string).replace(/, required of an? \w+$/, "").trim(),
    adds: /^add `## ([^`]+)`/.exec(m[3] as string)?.[1] ?? null,
  }));
}

/**
 * What a refusal listing its gaps (`- read:`, `wants:`, `clear:`) says was wrong, a whole sentence each:
 * the missing sections as one, then each other gap with what it wants (ISS-1229 r35, r39).
 */
function gapsReason(text: string): string[] {
  const gaps = gapsOf(text);
  const sections = gaps.flatMap((g) => (g.adds ? [g.adds] : []));
  return [
    ...(sections.length
      ? [`The ${listed(sections, "and")} section${sections.length === 1 ? " is" : "s are"} missing.`]
      : []),
    ...gaps.filter((g) => !g.adds).map((g) => `${capitalised(g.read)} needs ${g.wants}.`),
  ];
}

/**
 * As many whole sentences as fit beside the way out, at least one: else the first's leading clause, else
 * the first whole. Never cut at a character count (ISS-1229 r39); the rest is under technical details.
 */
function fitting(wrong: readonly string[], room: number): string {
  const [first = ""] = wrong;
  if (first.length > room) {
    const lead = leadClause(first);
    return lead.length <= room ? lead : first;
  }
  let line = first;
  for (const next of wrong.slice(1)) {
    if (line.length + 1 + next.length > room) break;
    line = `${line} ${next}`;
  }
  return line;
}

/**
 * The refusal's reason, one line, written for the person reading the room: what went wrong, read off
 * its gaps where it lists them, else its first sentence not written for the agent, after any opening
 * that only says it held the call ("Hold — …", r35). The way out is chosen by the refusal's kind, never
 * by its suggestion's wording: where it names a command a room does not open, where a person does that
 * act (r40); the person's own where the refusal is one of `PERSON_KINDS`; else, the call being the
 * assistant's, that it tried another way later in the same reply, claiming no more than its answer does,
 * else that they can ask it to put it right (r38). No command, flag or backtick reaches it.
 */
export function refusalReason(result: unknown, tool?: string, recovered = false): string {
  const text = refusalText(result);
  const known = PERSON_KINDS.find((p) => p.says.test(text));
  const closed = closedCommand(text);
  const remedy = closed ? whereItIsDone(closed) : (known?.remedy ?? (recovered ? TOOK_ANOTHER_WAY : PUT_IT_RIGHT));
  const paragraphs = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const held = paragraphs.length > 1 && /^Hold\b/.test(paragraphs[0] as string);
  // A machine code ("NOT_FOUND: …") or a tool's failure prefix leading a sentence is the technical view's.
  const sentences = paragraphs
    .slice(held ? 1 : 0)
    .flatMap(sentencesOf)
    .map((x) => capitalised(x.replace(/^[A-Z][A-Z_]{2,}:\s*/, "").replace(TOOL_PREFIX, "")));
  const gaps = gapsReason(text);
  const reason = sentences.find((x) => !FOR_THE_AGENT.test(x));
  const wrong = known?.wrong
    ? [known.wrong]
    : gaps.length
      ? gaps
      : reason
        ? [reason]
        : [sentences.length === 0 ? "It gave no reason." : "Its reason is under Technical details."];
  const fix = said(remedy, tool);
  return `${fitting(wrong.map((w) => said(w, tool)), REASON_CHARS - fix.length - 1)} ${fix}`;
}

/** A line as the card shows it: the tool's stored name and every backtick out. */
function said(line: string, tool: string | undefined): string {
  return (tool ? unnamed(line, tool) : line).replace(/`/g, "");
}

/** The reason with the tool's stored name taken out, which only the technical details show. */
function unnamed(reason: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`\\b${escaped}\\b`, "gi");
  const out = name === "forge"
    ? reason.replace(/`forge ([^`]+)`/g, "the tracker's $1 command").replace(word, "the tracker")
    : reason.replace(word, "the tool");
  return capitalised(out);
}

/** What the call did, in the tense it is in, and why it was refused where it was; `later` is the rest of its reply. */
export function toolWords(tool: ToolCallData, live = false, later: readonly ToolCallData[] = []): ToolWords {
  const a = actOf(tool) ?? { done: "Used a tool", refused: "Couldn't use a tool", running: "Using a tool…" };
  if (tool.isError === true) {
    return { said: a.refused, refusal: refusalReason(tool.result, tool.name, tookAnotherWay(tool, later)) };
  }
  if (tool.result === undefined && live) return { said: a.running };
  if (tool.name === "forge" && tool.input?.argv && (tool.input.argv as unknown[])[0] === "new") {
    const key = filedKey(tool);
    const title = flag((tool.input.argv as unknown[]).filter((x): x is string => typeof x === "string"), "--title");
    if (key) return { said: title ? `Filed ${key} — ${title}` : `Filed ${key}` };
  }
  const found = foundCount(tool);
  return { said: found === null ? a.done : `${a.done} — ${foundWords(found)}` };
}
