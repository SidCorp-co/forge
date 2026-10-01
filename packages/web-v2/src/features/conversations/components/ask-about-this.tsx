"use client";

import { Icon } from "@/design";
import type { AboutKind } from "../ask-about";
import { useChatDock } from "../dock";

export function AskAboutThis({ kind, refId }: { kind: AboutKind; refId: string }) {
  const dock = useChatDock();
  if (!dock?.projectId) return null;
  return (
    <button
      type="button"
      onClick={() => dock.askAbout(kind, refId)}
      className="inline-flex items-center justify-center gap-[6px] whitespace-nowrap rounded-md border border-line-strong bg-surface px-[11px] py-[6px] text-13 font-semibold leading-none text-fg transition-colors duration-[120ms] hover:bg-hover focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
    >
      <Icon name="chat" size={15} />
      Ask about this
    </button>
  );
}
