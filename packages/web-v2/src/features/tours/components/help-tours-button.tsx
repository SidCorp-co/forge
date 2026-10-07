"use client";

import { useState } from "react";
import { Icon } from "@/design";
import { cn } from "@/lib/utils/cn";
import { useTourCopy, useTourStates } from "../hooks";
import { TOURS } from "../registry";
import { standingOf } from "../state";
import { ToursPanel } from "./tours-panel";

/** The rail's Help entry, which opens Help → Tours; a dot while a tour the person finished has a newer revision. */
export function HelpToursButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = useTourCopy();
  const { states } = useTourStates();
  const updated = TOURS.some((tour) => standingOf(tour, states.get(tour.id)) === "updated");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tour="nav-help"
        aria-label={t("help.title")}
        className={cn(
          "relative flex items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg max-md:min-h-[44px]",
          compact ? "w-full flex-col gap-0.5 px-1 py-1.5 text-9-5" : "w-full gap-2.5 px-1.5 py-1.5 text-13",
        )}
      >
        <Icon name="help" size={compact ? 15 : 16} />
        <span className={cn(!compact && "flex-1 text-left")}>{t("help.nav")}</span>
        {updated && (
          <span
            aria-hidden
            className={cn("size-2 rounded-pill bg-accent", compact ? "absolute right-4 top-1" : "flex-none")}
          />
        )}
      </button>
      <ToursPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
