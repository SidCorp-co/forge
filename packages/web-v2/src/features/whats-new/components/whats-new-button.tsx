"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useMarkWhatsNewSeen, useWhatsNew, useWhatsNewSummary } from "../hooks";
import type { WhatsNewFeed } from "../types";
import { type WhatsNewEntryAction, WhatsNewPanel } from "./whats-new-panel";

/**
 * The rail's What's new entry: a dot while anything shipped after the reader's seen mark, never a
 * count, read from the summary every page loads. Opening it reads the feed, shows it as it stood and
 * moves the mark to now, which clears the dot.
 */
export function WhatsNewButton({ compact = false, entryAction }: { compact?: boolean; entryAction?: WhatsNewEntryAction }) {
  const summary = useWhatsNewSummary();
  const markSeen = useMarkWhatsNewSeen();
  const [open, setOpen] = useState(false);
  const feedQ = useWhatsNew(open);
  const [shown, setShown] = useState<WhatsNewFeed | undefined>(undefined);
  const openedAt = useRef(0);
  const unread = summary.data?.unread ?? 0;
  const t = useCopy();
  const failure = open && feedQ.error ? "failed" : null;
  const { mutate: markSeenNow } = markSeen;

  useEffect(() => {
    if (!open || shown || !feedQ.data || feedQ.isFetching || feedQ.dataUpdatedAt < openedAt.current) return;
    setShown(feedQ.data);
    markSeenNow();
  }, [open, shown, feedQ.data, feedQ.isFetching, feedQ.dataUpdatedAt, markSeenNow]);

  function openPanel() {
    openedAt.current = Date.now();
    setShown(undefined);
    setOpen(true);
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
      <WhatsNewPanel
        open={open}
        onClose={() => setOpen(false)}
        feed={shown}
        failure={failure}
        loading={open && !shown && !failure}
        entryAction={entryAction}
      />
    </>
  );
}
