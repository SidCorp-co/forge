import type { PatToken } from "./types";

// No origin is stored: it is read from the name the minter wrote (`forge-cli.ts:runForgeCli`, `pat-format.ts:deviceTokenNameFor`).
const CHAT_TURN_NAME = /^chat turn \d{4}-\d{2}-\d{2}T[\d:.]+Z [0-9a-f]{8}$/;

export type TokenOrigin = "chat-turn" | "box" | "you";

export function originOf(token: Pick<PatToken, "name">): TokenOrigin {
  if (CHAT_TURN_NAME.test(token.name)) return "chat-turn";
  if (token.name.startsWith("device:") || token.name.startsWith("workspace:")) return "box";
  return "you";
}

export const ORIGIN_WORDS: Record<TokenOrigin, string> = {
  "chat-turn": "the assistant, for one chat turn",
  box: "a paired box",
  you: "you",
};

export type TokenEnd = { kind: "revoked" | "expired"; at: string };

/** Why a token no longer reaches the account, by the server's test (`auth/pat-live.ts:patIsLive`); null while it does. */
export function endOf(token: Pick<PatToken, "revokedAt" | "expiresAt">, now: number): TokenEnd | null {
  if (token.revokedAt) return { kind: "revoked", at: token.revokedAt };
  if (token.expiresAt && Date.parse(token.expiresAt) <= now) return { kind: "expired", at: token.expiresAt };
  return null;
}

export interface TokenGroups {
  live: PatToken[];
  ended: PatToken[];
  /** Counted, never listed. */
  chatTurn: { total: number; live: number };
  /** Every token that can reach the account, chat-turn ones included. */
  reaching: number;
}

export function groupTokens(tokens: readonly PatToken[], now: number): TokenGroups {
  const groups: TokenGroups = { live: [], ended: [], chatTurn: { total: 0, live: 0 }, reaching: 0 };
  for (const token of tokens) {
    const alive = endOf(token, now) === null;
    if (alive) groups.reaching += 1;
    if (originOf(token) === "chat-turn") {
      groups.chatTurn.total += 1;
      if (alive) groups.chatTurn.live += 1;
    } else {
      (alive ? groups.live : groups.ended).push(token);
    }
  }
  return groups;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The statement above the list, in words. */
export function reachStatement(reaching: number): string {
  if (reaching === 0) return "No token can reach your account.";
  return `${plural(reaching, "token", "tokens")} can reach your account.`;
}

/** The one line that stands where the ended tokens would be. */
export function endedLine(ended: number): string {
  return `${plural(ended, "token", "tokens")} no longer reach${ended === 1 ? "es" : ""} your account (revoked or expired)`;
}

/** The line that stands in place of the chat-turn credentials, or null when there are none. */
export function chatTurnLine(chatTurn: TokenGroups["chatTurn"]): string | null {
  if (chatTurn.total === 0) return null;
  const live = chatTurn.live === 0 ? "none are live" : `${chatTurn.live} ${chatTurn.live === 1 ? "is" : "are"} live`;
  return `${plural(chatTurn.total, "credential", "credentials")} made by the assistant for single chat turns, ${live}. Each is revoked when its turn ends, and otherwise expires within ten minutes.`;
}
