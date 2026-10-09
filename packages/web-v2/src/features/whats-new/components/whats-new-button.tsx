"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useMarkWhatsNewSeen, useWhatsNew, useWhatsNewSummary } from "../hooks";
import type { WhatsNewFeed } from "../types";
import { WhatsNewPanel } from "./whats-new-panel";

/** The releases this tab has already opened What's new on by itself: once each, however many entries mount. */
const openedByItself = new Set<string>();

/** Test seam: forget what this tab opened. */
export function forgetOpenedWhatsNew() {
  openedByItself.clear();
}

/**
 * The rail's What's new entry. Where the summary says the serving release is owed, it opens by itself
 * once (a dot stands until then); opening it reads the release and shows it as it stood. Closing it
 * on an owed release writes the mark that names that release, which clears the dot and owes nothing
 * more on it. Opened by hand with nothing owed, it shows the release and writes nothing.
 */
export function WhatsNewButton({ compact = false }: { compact?: boolean }) {
  const summary = useWhatsNewSummary();
  const markSeen = useMarkWhatsNewSeen();
  const [open, setOpen] = useState(false);
  const feedQ = useWhatsNew(open);
  const [shown, setShown] = useState<WhatsNewFeed | undefined>(undefined);
  const t = useCopy();
  const owed = summary.data?.release?.owed === true;
  const failure = open && feedQ.error ? "failed" : null;
  const { mutate: writeMark } = markSeen;

  useEffect(() => {
    const release = summary.data?.release;
    if (!release?.owed || !summary.data) return;
    const key = `${summary.data.environment}:${release.version}`;
    if (openedByItself.has(key)) return;
    openedByItself.add(key);
    setShown(undefined);
    setOpen(true);
  }, [summary.data]);

  useEffect(() => {
    if (open && !shown && feedQ.data && !feedQ.isFetching) setShown(feedQ.data);
  }, [open, shown, feedQ.data, feedQ.isFetching]);

  function openPanel() {
    setShown(undefined);
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    if (shown?.release?.owed) writeMark({ environment: shown.environment, version: shown.release.version });
  }

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        data-tour="nav-whats-new"
        aria-label={owed ? `${t("whatsNew.nav")}, ${t("whatsNew.unreadHint")}` : t("whatsNew.nav")}
        className={cn(
          "relative flex items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg max-md:min-h-[44px]",
          compact ? "w-full flex-col gap-0.5 px-1 py-1.5 text-9-5" : "w-full gap-2.5 px-1.5 py-1.5 text-13",
        )}
      >
        <Icon name="star" size={compact ? 15 : 16} />
        <span className={cn(!compact && "flex-1 text-left")}>{t("whatsNew.nav")}</span>
        {owed && (
          <span data-testid="whats-new-dot" aria-hidden className={cn("size-2 rounded-pill bg-accent", compact ? "absolute right-4 top-1" : "flex-none")} />
        )}
      </button>
      <WhatsNewPanel open={open} onClose={closePanel} feed={shown} failure={failure} loading={open && !shown && !failure} />
    </>
  );
}
