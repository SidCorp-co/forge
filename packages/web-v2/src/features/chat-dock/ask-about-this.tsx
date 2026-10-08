"use client";

import { Icon } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { AskAbout } from "./ask-about";
import { useChatDock } from "./dock";

/** Opens a fresh draft about `about`; `null` is the record whose page this is, which the turn reads as its page item. */
export function AskAboutThis({ about }: { about: AskAbout }) {
  const dock = useChatDock();
  const t = useCopy();
  if (!dock?.projectId) return null;
  return (
    <button
      type="button"
      onClick={() => dock.askAbout(about)}
      className="inline-flex items-center justify-center gap-[6px] whitespace-nowrap rounded-md border border-line-strong bg-surface px-[11px] py-[6px] text-13 font-semibold leading-none text-fg transition-colors duration-[120ms] hover:bg-hover focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
    >
      <Icon name="chat" size={15} />
      {t("common.askAboutThis")}
    </button>
  );
}
