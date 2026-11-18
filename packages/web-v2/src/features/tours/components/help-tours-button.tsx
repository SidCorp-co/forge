
import { type ReactNode, useState } from "react";
import { RailButton } from "@/design";
import { useTourCopy, useTourStates } from "../hooks";
import { TOURS } from "../registry";
import { standingOf } from "../state";
import { ToursSheet } from "./tours-panel";

/** Help → Tours as an entry anywhere it is drawn: whether a finished tour has a newer revision, the act that opens it, and its sheet. */
export function useHelpTours(): { updated: boolean; open: () => void; sheet: ReactNode } {
  const [open, setOpen] = useState(false);
  const { states } = useTourStates();
  const updated = TOURS.some((tour) => standingOf(tour, states.get(tour.id)) === "updated");
  return { updated, open: () => setOpen(true), sheet: <ToursSheet open={open} onClose={() => setOpen(false)} /> };
}

/** The phone drawer's Help entry, which opens Help → Tours; a dot while a tour the person finished has a newer revision. */
export function HelpToursButton() {
  const t = useTourCopy();
  const help = useHelpTours();
  return (
    <>
      <RailButton icon="help" label={t("help.nav")} ariaLabel={t("help.title")} dot={help.updated} tour="nav-help" onClick={help.open} />
      {help.sheet}
    </>
  );
}
