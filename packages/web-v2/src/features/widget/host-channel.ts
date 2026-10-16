import {
  WIDGET_POST_MESSAGE_SOURCE,
  type WidgetFrameMessage,
  type WidgetHostMessage,
  widgetPageContextSchema,
  widgetSessionRequestSchema,
} from "@forge/contracts/widget";

// The frame's side of the postMessage channel with the loader on the client page. A message is taken
// only from the page that embeds this frame (its parent window, at the parent's origin); core enforces
// which origins may embed a site key. Each message is read against the contract's own schemas, and a
// wrong one is refused by name, never guessed at.

/**
 * The origin of the page embedding this frame: the browser's own ancestor list where it keeps one,
 * else the referrer the loader's iframe sends (`referrerpolicy="origin"`). Null when not embedded.
 */
export function parentOriginOf(win: Window = window): string | null {
  if (win.parent === win) return null;
  const ancestors = win.location.ancestorOrigins as DOMStringList | undefined;
  if (ancestors && ancestors.length > 0) return ancestors.item(0);
  try {
    return win.document.referrer ? new URL(win.document.referrer).origin : null;
  } catch {
    return null;
  }
}

export type HostRead = { message: WidgetHostMessage } | { fault: string } | null;

const signedSchema = widgetSessionRequestSchema.pick({ signed: true });

function issueOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = error.issues[0];
  return first ? `${first.path.map(String).join(".") || "(root)"}: ${first.message}` : "it does not match the contract";
}

/**
 * A host message read: the message, a fault naming why it is refused, or null where it is not the
 * widget's at all (another script's postMessage on the same window).
 */
export function hostMessageOf(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  parentOrigin: string | null,
  parent: Window | null,
): HostRead {
  const data = event.data as { source?: unknown; type?: unknown; context?: unknown; signed?: unknown } | null;
  if (!data || typeof data !== "object" || data.source !== WIDGET_POST_MESSAGE_SOURCE) return null;
  if (!parentOrigin || event.origin !== parentOrigin)
    return { fault: `a message from ${event.origin || "an unknown origin"} is not from the page embedding this frame` };
  if (!parent || event.source !== parent) return { fault: "a message did not come from the window embedding this frame" };
  switch (data.type) {
    case "open":
    case "close":
      return { message: { source: WIDGET_POST_MESSAGE_SOURCE, type: data.type } };
    case "context": {
      const read = widgetPageContextSchema.safeParse(data.context);
      return read.success
        ? { message: { source: WIDGET_POST_MESSAGE_SOURCE, type: "context", context: read.data } }
        : { fault: `context refused at ${issueOf(read.error)}` };
    }
    case "identify": {
      const read = signedSchema.safeParse({ signed: data.signed });
      return read.success && read.data.signed
        ? { message: { source: WIDGET_POST_MESSAGE_SOURCE, type: "identify", signed: read.data.signed } }
        : { fault: `identify refused at ${read.success ? "signed: missing" : issueOf(read.error)}` };
    }
    default:
      return { fault: `"${String(data.type)}" is not a message the frame takes` };
  }
}

/** What the frame says to the page, the source added on the way out. */
export type FrameSays = { type: "ready" | "close" } | { type: "unread"; count: number };

/** Tells the embedding page something, at its origin only; nothing when the frame is not embedded. */
export function postToHost(message: FrameSays, parentOrigin: string | null) {
  if (!parentOrigin || window.parent === window) return;
  const sent: WidgetFrameMessage = { ...message, source: WIDGET_POST_MESSAGE_SOURCE };
  window.parent.postMessage(sent, parentOrigin);
}
