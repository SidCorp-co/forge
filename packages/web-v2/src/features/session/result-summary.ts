
/**
 * A captured tool output, read back as the value the tool actually returned.
 */
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
export function summarizeResult(
  result: unknown,
  isError?: boolean,
  live?: boolean,
): ResultSummary {
  if (isError === true) {
    const text = errorText(result);
    return { label: text ? `Failed · ${text}` : "Failed", hasBody: result != null, pending: false };
  }
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
  return { label: String(result), hasBody: false, pending: false };
}

/**
 * The value as a reader should see it when they ask for it: whole, and not on one line.
 */
export function formatResultBody(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    // A cyclic or otherwise unserializable value still has to show a reader something true.
    return String(result);
  }
}
