// What a live assistant turn is doing right now, in words, for the stage line under the thread: the
// tool it is waiting on, or that it is reading the project before its first call.

import { CHAT_ACT_TOOL } from "@forge/contracts/chat-acts";
import { getToolLabel, type RenderBlock } from "@/features/session/types";
import type { Copy } from "@/lib/i18n/product-copy";

const FILING_VERBS: ReadonlySet<string> = new Set(["new", "comment", "attach"]);
const WHAT_CHARS = 60;

const clip = (s: string) => (s.length > WHAT_CHARS ? `${s.slice(0, WHAT_CHARS)}…` : s);

export function turnDoing(blocks: readonly RenderBlock[] | undefined, t: Copy): string | null {
  if (!blocks || blocks.length === 0) return t("conversations.stage.doing.start");
  const last = blocks[blocks.length - 1];
  if (last?.type !== "tool" || last.tool.result !== undefined) return null;
  const { name, input } = last.tool;
  if (name === "forge") {
    const argv = Array.isArray(input?.argv) ? (input.argv as unknown[]).map(String) : [];
    const what = clip(`forge ${argv.join(" ")}`);
    return FILING_VERBS.has(argv[0] ?? "")
      ? t("conversations.stage.doing.filing", { what })
      : t("conversations.stage.doing.tracker", { what });
  }
  if (name === "forge_knowledge") return t("conversations.stage.doing.knowledge");
  if (name === "forge_memory") return t("conversations.stage.doing.memory");
  if (name === CHAT_ACT_TOOL) return t("conversations.stage.doing.act");
  return t("conversations.stage.doing.other", { what: clip(getToolLabel(last.tool)) });
}
