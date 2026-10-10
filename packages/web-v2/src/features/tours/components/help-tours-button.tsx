"use client";

import { useState } from "react";
import { RailButton } from "@/design";
import { useTourCopy, useTourStates } from "../hooks";
import { TOURS } from "../registry";
import { standingOf } from "../state";
import { ToursSheet } from "./tours-panel";

/** The rail's Help entry, which opens Help → Tours; a dot while a tour the person finished has a newer revision. */
export function HelpToursButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = useTourCopy();
  const { states } = useTourStates();
  const updated = TOURS.some((tour) => standingOf(tour, states.get(tour.id)) === "updated");
  return (
    <>
      <RailButton icon="help" label={t("help.nav")} ariaLabel={t("help.title")} dot={updated} compact={compact} tour="nav-help" onClick={() => setOpen(true)} />
      <ToursSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
