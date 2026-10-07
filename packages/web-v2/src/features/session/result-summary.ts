
import { type Copy, productCopy } from "@/lib/i18n/product-copy";

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
  t: Copy = productCopy(),
): ResultSummary {
  if (isError === true) {
    const text = errorText(result);
    return { label: text ? t("sessions.result.failedWith", { text }) : t("sessions.result.failed"), hasBody: result != null, pending: false };
  }
  if (result === undefined) {
    return live === true
      ? { label: t("sessions.result.running"), hasBody: false, pending: true }
      : { label: t("sessions.result.noOutput"), hasBody: false, pending: false };
  }
  if (result === null || result === "") {
    return { label: t("sessions.result.none"), hasBody: false, pending: false };
  }
  if (Array.isArray(result)) {
    const n = result.length;
    return { label: n === 1 ? t("sessions.result.arrayOne") : t("sessions.result.arrayMany", { n }), hasBody: true, pending: false };
  }
  if (typeof result === "string") {
    const n = result.length;
    return { label: n === 1 ? t("sessions.result.textOne") : t("sessions.result.textMany", { n }), hasBody: true, pending: false };
  }
  if (typeof result === "object") {
    const n = Object.keys(result as Record<string, unknown>).length;
    return { label: n === 1 ? t("sessions.result.objectOne") : t("sessions.result.objectMany", { n }), hasBody: true, pending: false };
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
