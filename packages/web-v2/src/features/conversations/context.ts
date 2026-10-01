export interface RoomToolCall {
  turnId: string;
  at: string;
  name: string;
  arguments: string;
  round: number;
  isError: boolean;
  durationMs: number | null;
  resultPreview: string | null;
  resultIssueRefs: string[];
  ranAsRecorded: boolean;
  ranAs: string | null;
  refusalCode: string | null;
}

export interface RoomToolCalls {
  conversationId: string;
  calls: RoomToolCall[];
}

export const CHANNEL_TOOL = "forge_channel";
const DOCUMENT_WRITES = new Set(["draft", "reply", "edit", "submit", "withdraw", "supersede", "gate"]);
const HOLD_WRITES = new Set(["hold", "release"]);

export type RanAs = "you" | "another-member" | "nobody" | "unrecorded";

// cm:guard "ran with your permissions" is earned only by a recorded ranAs equal to the reader; a call that ran as nobody, as someone else, or whose ranAs was never recorded says so instead
export function ranAsOf(call: Pick<RoomToolCall, "ranAs" | "ranAsRecorded">, me: string | null): RanAs {
  if (!call.ranAsRecorded) return "unrecorded";
  if (call.ranAs === null) return "nobody";
  return me !== null && call.ranAs === me ? "you" : "another-member";
}

export const RAN_AS_LINE: Record<RanAs, string> = {
  you: "Ran with your permissions",
  "another-member": "Ran with another member's permissions",
  nobody: "Ran as no one: a tool of the room itself",
  unrecorded: "Who this ran as was not recorded",
};

export function argsOf(call: Pick<RoomToolCall, "arguments">): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export interface ChannelTouch {
  key: string;
  kind: "document" | "hold";
  action: string;
  subject: string;
  refused: boolean;
  refusalCode: string | null;
}

export interface RoomContext {
  sources: Array<{ name: string; count: number }>;
  calls: Array<RoomToolCall & { key: string }>;
  channel: ChannelTouch[];
  issues: string[];
}

function channelTouch(call: RoomToolCall, index: number): ChannelTouch | null {
  if (call.name !== CHANNEL_TOOL) return null;
  const args = argsOf(call);
  const action = text(args.action);
  if (!action) return null;
  const kind = DOCUMENT_WRITES.has(action) ? "document" : HOLD_WRITES.has(action) ? "hold" : null;
  if (!kind) return null;
  const subject =
    kind === "hold"
      ? (text(args.thread) ?? "a thread")
      : (text(args.ref) ?? text(args.inReplyTo) ?? text(args.subject) ?? "a new document");
  return {
    key: `${call.turnId}:${index}`,
    kind,
    action,
    subject,
    refused: call.isError,
    refusalCode: call.refusalCode,
  };
}

export function roomContext(calls: RoomToolCall[]): RoomContext {
  const sourceCount = new Map<string, number>();
  const channel: ChannelTouch[] = [];
  const issues: string[] = [];
  calls.forEach((call, i) => {
    const touch = channelTouch(call, i);
    if (touch) channel.push(touch);
    else if (!call.isError) sourceCount.set(call.name, (sourceCount.get(call.name) ?? 0) + 1);
    for (const ref of call.resultIssueRefs) if (!issues.includes(ref)) issues.push(ref);
  });
  return {
    sources: [...sourceCount].map(([name, count]) => ({ name, count })),
    calls: calls.map((call, i) => ({ ...call, key: `${call.turnId}:${i}` })),
    channel,
    issues,
  };
}
