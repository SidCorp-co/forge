"use client";

import { useState } from "react";
import { Icon } from "@/design";
import { productCopy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useMarkWhatsNewSeen, useWhatsNew } from "../hooks";
import type { WhatsNewFeed } from "../types";
import { type WhatsNewEntryAction, WhatsNewPanel } from "./whats-new-panel";

/**
 * The rail's What's new entry: a dot while anything shipped after the reader's seen mark, never a
 * count. Opening it shows the feed as it stood and moves the mark to now, which clears the dot.
 */
export function WhatsNewButton({ compact = false, entryAction }: { compact?: boolean; entryAction?: WhatsNewEntryAction }) {
  const query = useWhatsNew();
  const markSeen = useMarkWhatsNewSeen();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<WhatsNewFeed | undefined>(undefined);
  const feed = query.data;
  const unread = feed?.unread ?? 0;
  const t = productCopy();
  const failure = query.error ? "failed" : null;

  function openPanel() {
    setShown(feed);
    setOpen(true);
    if (feed) markSeen.mutate();
  }

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        data-tour="nav-whats-new"
        aria-label={unread > 0 ? `${t("whatsNew.nav")}, ${t("whatsNew.unreadHint", { count: unread })}` : t("whatsNew.nav")}
        className={cn(
          "relative flex items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg max-md:min-h-[44px]",
          compact ? "w-full flex-col gap-0.5 px-1 py-1.5 text-9-5" : "w-full gap-2.5 px-1.5 py-1.5 text-13",
        )}
      >
        <Icon name="star" size={compact ? 15 : 16} />
        <span className={cn(!compact && "flex-1 text-left")}>{t("whatsNew.nav")}</span>
        {unread > 0 && (
          <span
            data-testid="whats-new-dot"
            aria-hidden
            className={cn("size-2 rounded-pill bg-accent", compact ? "absolute right-4 top-1" : "flex-none")}
          />
        )}
      </button>
      <WhatsNewPanel open={open} onClose={() => setOpen(false)} feed={shown ?? feed} failure={failure} entryAction={entryAction} />
    </>
  );
}
