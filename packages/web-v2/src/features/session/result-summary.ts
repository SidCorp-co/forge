// One line describing what a tool call returned, and the rule is the VALUE'S SHAPE and nothing
// else (ISS-1083).
//
// What this replaced: `tool-card.tsx:resultPreview`, which was `JSON.stringify(result)` sliced at
// 240 characters and printed inline. Every `forge_*` MCP tool answers with an object, so the common
// case on screen was a wall of minified JSON cut mid-key — and the rest was lost with nothing
// saying so.
//
// cm:guard no tool NAME and no field NAME reaches this function, and that is the whole of why it is
// worth having. The obvious improvement is to read a well-known field — `returned`, `count`,
// `items` — and say "No pipeline runs" instead of "Object · 1 field". That is a per-tool registry
// that has not been written down yet, and the tool added next month falls out of it in silence. The
// assistant's own prose is what tells a reader there are none, and a reader believes the prose. So
// the whole of the rule below is `typeof`, `Array.isArray` and `Object.keys().length`.

/**
 * A captured tool output, read back as the value the tool actually returned.
 */
// cm:guard the canonical wire carries a tool's output as a STRING, always: the assistant path's
// accumulator writes `typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '')`
// (core `assistant/transcript-entry.ts`), and the CLI path lifts the stream-json result's text. So
// without this, every summary below sees a string and every real card read `Text · N characters` —
// which is exactly what the first cut of this module did, while 31 tests that fed it objects
// directly stayed green. The implementation consult caught it (F1); the boundary is asserted now.
//
// cm:why prose is left as prose: a first character of `{`, `[`, `"`, a digit, or one of the three
// JSON literals is the whole of the test, so "three issues, one blocked" stays a string and never
// takes a parse it would fail anyway. `''` is a call that captured nothing rather than an empty
// answer of its own, and `'""'` — which is what the accumulator writes for a null result — decodes
// to the empty string the `No result` rule below already knows.
export function decodeToolOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text === "") return null;
  if (!/^[[{"]|^-?\d|^(?:true|false|null)$/.test(text)) return raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
}

/** How long an error message may run before the summary shortens it. */
const ERROR_CHARS = 120;

export interface ResultSummary {
  /** The one line the card shows where the serialized value used to be. */
  label: string;
  /** Whether there is a value worth opening onto. */
  hasBody: boolean;
  /** No result has arrived — the call is still out. */
  pending: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_CHARS ? `${flat.slice(0, ERROR_CHARS)}…` : flat;
}

/** The error's own words, wherever this wire put them. */
// cm:why this ONE read of a field name is not the registry the guard above refuses: it is not asking
// what a tool means by its answer, it is asking where a thrown error's message is, and `message` is
// the name every JavaScript error on either side of this wire uses. It says nothing about any tool.
function errorText(result: unknown): string {
  if (typeof result === "string") return shorten(result);
  if (result != null && typeof result === "object") {
    const m = (result as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return shorten(m);
  }
  return "";
}

/**
 * What came back, in one line.
 */
// cm:guard a call that COMPLETED carrying nothing is not a call still running, and what tells them
// apart is whether the `result` key is there at all — never whether its value is truthy. The
// derive's settle writes `output` unconditionally (core `agent-stream-parser.ts:mergeMessages`), so
// `null`, `""` and `[]` are all legitimate answers from a tool that worked, and reading emptiness
// as "not finished" would leave a settled card spinning forever.
export function summarizeResult(
  result: unknown,
  isError?: boolean,
  live?: boolean,
): ResultSummary {
  if (isError === true) {
    const text = errorText(result);
    return { label: text ? `Failed · ${text}` : "Failed", hasBody: result != null, pending: false };
  }
  // cm:guard an absent result is "still out" ONLY where the caller can say the turn is live, and
  // that is a fact about the run rather than about the value. Reading absence as running on its own
  // is the lifecycle state being INVENTED, which this issue's own rules refuse: a settled turn in
  // history whose tool captured nothing would have claimed a call was in flight forever. The caller
  // already holds the answer — `AgentTurn`'s `streamingTail` — so nothing new is computed for it
  // (implementation consult round 3, F1).
  if (result === undefined) {
    return live === true
      ? { label: "Running…", hasBody: false, pending: true }
      : { label: "No output recorded", hasBody: false, pending: false };
  }
  if (result === null || result === "") {
    return { label: "No result", hasBody: false, pending: false };
  }
  if (Array.isArray(result)) {
    return { label: `Array · ${plural(result.length, "item", "items")}`, hasBody: true, pending: false };
  }
  if (typeof result === "string") {
    return {
      label: `Text · ${plural(result.length, "character", "characters")}`,
      hasBody: true,
      pending: false,
    };
  }
  if (typeof result === "object") {
    const n = Object.keys(result as Record<string, unknown>).length;
    return { label: `Object · ${plural(n, "field", "fields")}`, hasBody: true, pending: false };
  }
  // A number or a boolean is short enough to BE its own summary, and a reader who sees `0` has the
  // whole answer rather than a description of it.
  return { label: String(result), hasBody: false, pending: false };
}

/**
 * The value as a reader should see it when they ask for it: whole, and not on one line.
 */
// cm:guard pretty-printed and NEVER truncated. The 240-character slice this replaced lost the rest
// in silence, which is the failure mode the disclosure exists to end: a summary that says it is a
// summary, over a body that is all of it.
export function formatResultBody(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    // A cyclic or otherwise unserializable value still has to show a reader something true.
    return String(result);
  }
}
