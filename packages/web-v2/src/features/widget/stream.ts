import {
  WIDGET_DRAFT_KINDS,
  WIDGET_DRAFT_STATES,
  type WidgetFeedbackDraft,
  type WidgetMessage,
  type WidgetStreamEvent,
} from "@forge/contracts/widget";
import { isWidgetCode, send, WidgetRefusal } from "./api";

// `GET /api/widget/session/stream` is server-sent events on the session token. EventSource cannot set
// an Authorization header, so the frame reads the body itself: `SseParser` cuts it into events, and
// `streamEventOf` reads each one's JSON as a `WidgetStreamEvent` or says by name why it is not one.

export interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

/** An incremental parser of the event-stream format (WHATWG HTML, server-sent events): feed it text as it arrives. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private lastCr = false;

  push(chunk: string): SseFrame[] {
    let text = chunk;
    // a CRLF split across two chunks: the LF of a CR already taken ends nothing
    if (this.lastCr && text.startsWith("\n")) text = text.slice(1);
    this.lastCr = text.endsWith("\r");
    this.buffer += text;
    const frames: SseFrame[] = [];
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const frame = { event: this.event || "message", data: this.data.join("\n"), id: this.id };
      this.data = [];
      this.event = "";
      return frame;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}

export type StreamRead = { event: WidgetStreamEvent } | { fault: string };

const isText = (v: unknown): v is string => typeof v === "string";
const isTextOrNull = (v: unknown) => v === null || isText(v);
const DRAFT_KINDS: readonly string[] = WIDGET_DRAFT_KINDS;
const DRAFT_STATES: readonly string[] = WIDGET_DRAFT_STATES;

function messageFault(m: Partial<WidgetMessage> | undefined): string | null {
  if (!m || typeof m !== "object") return "a message event carries no message";
  if (!isText(m.id) || !isText(m.text) || !isText(m.at)) return "a message event's message lacks id, text or at";
  if (m.role !== "visitor" && m.role !== "assistant") return `a message's role "${String(m.role)}" is neither visitor nor assistant`;
  return null;
}

function draftFault(d: Partial<WidgetFeedbackDraft> | undefined): string | null {
  if (!d || typeof d !== "object") return "a draft event carries no draft";
  if (!isText(d.draftId) || !isText(d.title) || !isText(d.saw)) return "a draft lacks draftId, title or saw";
  if (!isTextOrNull(d.did) || !isTextOrNull(d.expected) || !isTextOrNull(d.whereSeen))
    return "a draft's did, expected or whereSeen is neither text nor null";
  if (!DRAFT_KINDS.includes(String(d.kind))) return `a draft's kind "${String(d.kind)}" is not one the contract names`;
  if (!DRAFT_STATES.includes(String(d.state))) return `a draft's state "${String(d.state)}" is not one the contract names`;
  const filed = d.filed as { feedbackKey?: unknown; statusUrl?: unknown } | null | undefined;
  if (filed != null && (typeof filed !== "object" || !isText(filed.feedbackKey) || !isText(filed.statusUrl)))
    return "a draft's filed lacks feedbackKey or statusUrl";
  return null;
}

function faultOf(e: Record<string, unknown>): string | null {
  switch (e.type) {
    case "message":
      return messageFault(e.message as Partial<WidgetMessage> | undefined);
    case "typing":
      return typeof e.on === "boolean" ? null : "a typing event's on is not a boolean";
    case "draft":
      return draftFault(e.draft as Partial<WidgetFeedbackDraft> | undefined);
    case "filed":
      return isText(e.draftId) && isText(e.feedbackKey) && isText(e.statusUrl)
        ? null
        : "a filed event lacks draftId, feedbackKey or statusUrl";
    case "limit":
      return isWidgetCode(e.code) && isText(e.detail) ? null : `a limit event's code "${String(e.code)}" is not a widget refusal code`;
    default:
      return `"${String(e.type)}" is not a widget stream event type`;
  }
}

/** One event's data as the contract's event, or the reason it is not one. */
export function streamEventOf(data: string): StreamRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { fault: "an event's data is not JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { fault: "an event's data is not a JSON object" };
  const fault = faultOf(parsed as Record<string, unknown>);
  return fault ? { fault } : { event: parsed as WidgetStreamEvent };
}

/**
 * Reads the session's stream until core ends it or `signal` aborts, handing each event or fault on.
 * A refused open (an expired session) throws the refusal; the caller decides whether to reconnect.
 */
export async function readStream(
  token: string,
  { signal, onRead, onOpen }: { signal: AbortSignal; onRead: (read: StreamRead) => void; onOpen?: () => void },
): Promise<void> {
  const res = await send("/session/stream", { headers: { Accept: "text/event-stream" }, signal }, token);
  if (!res.body) throw new Error("the stream answered with no body to read");
  onOpen?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) onRead(streamEventOf(frame.data));
    }
  } finally {
    reader.releaseLock();
  }
}

/** The waits between reconnects, in ms: quick at first, then no faster than every half minute. */
export const RECONNECT_WAITS = [1000, 2000, 4000, 8000, 15000, 30000];

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface FollowHandlers {
  onRead: (read: StreamRead) => void;
  /** The stream is open: the caller reads the history again, to fill what passed while it was down. */
  onOpen: () => void;
  onRetry: () => void;
  /** Core refused the stream by a code; following stops. */
  onRefused: (refusal: WidgetRefusal) => void;
}

/**
 * Keeps the session's stream open until `signal` aborts: a dropped connection or a server error is
 * reconnected after a wait, a refusal by code (an expired session) ends it.
 */
export async function follow(token: string, signal: AbortSignal, on: FollowHandlers): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await readStream(token, {
        signal,
        onRead: on.onRead,
        onOpen: () => {
          attempt = 0;
          on.onOpen();
        },
      });
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof WidgetRefusal && err.status < 500) {
        on.onRefused(err);
        return;
      }
    }
    if (signal.aborted) return;
    on.onRetry();
    await pause(RECONNECT_WAITS[Math.min(attempt, RECONNECT_WAITS.length - 1)] ?? 30000, signal);
    attempt += 1;
  }
}
