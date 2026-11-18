
import { type ReactNode, useEffect, useState } from "react";
import { RailButton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { closeAutoOpened, useAutoOpenedRelease, useMarkWhatsNewSeen, useWhatsNew, useWhatsNewSummary } from "../hooks";
import { WhatsNewSheet } from "./whats-new-panel";

export { forgetOpenedWhatsNew } from "../hooks";

/** What's new as an entry anywhere it is drawn: whether a release is owed, the act that opens it, and its sheet to mount. */
export interface WhatsNewEntry {
  owed: boolean;
  open: () => void;
  sheet: ReactNode;
}

/**
 * What's new, opened by itself once per release (REQ-40 BC-10: people see What's new once per
 * instance after a release reaches it). Where the summary says the serving release is owed, it opens
 * by itself (`hooks.ts:readSummary`); opening it reads the release and shows it as it stood. Showing
 * an owed release writes the mark that names it, so it is seen once whether the person closes it,
 * leaves it open, reloads or signs in again (ISS-1073: on dev.567 only a close wrote the mark, and it
 * opened on every page load until one did); the mark clears the dot and owes nothing more on it.
 * Opened by hand with nothing owed, it shows the release and writes nothing. The rail draws it as a
 * row of its account menu (ISS-1331), the phone's drawer as {@link WhatsNewButton}.
 */
export function useWhatsNewEntry(): WhatsNewEntry {
  const summary = useWhatsNewSummary();
  const { mutate: writeMark } = useMarkWhatsNewSeen();
  const autoOpened = useAutoOpenedRelease();
  // opened by hand: when, so only a read taken since shows
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const open = openedAt !== null || autoOpened !== null;
  const feedQ = useWhatsNew(open);
  // the release as it stood when the panel opened: never an earlier read, nor the mark the close writes
  const shown = open && feedQ.data && feedQ.dataUpdatedAt >= (openedAt ?? 0) ? feedQ.data : undefined;
  const failure = open && feedQ.error ? "failed" : null;
  const owed = summary.data?.release?.owed === true;

  // the release shown is the release seen: its mark is written as it shows, once (the write clears `owed`)
  const seenEnvironment = shown?.release?.owed ? shown.environment : null;
  const seenVersion = shown?.release?.owed ? shown.release.version : null;
  useEffect(() => {
    if (seenEnvironment !== null && seenVersion !== null) writeMark({ environment: seenEnvironment, version: seenVersion });
  }, [seenEnvironment, seenVersion, writeMark]);

  function closePanel() {
    setOpenedAt(null);
    closeAutoOpened();
  }

  return {
    owed,
    open: () => setOpenedAt(Date.now()),
    sheet: <WhatsNewSheet open={open} onClose={closePanel} feed={shown} failure={failure} loading={open && !shown && !failure} />,
  };
}

/** The phone drawer's What's new row: its icon and name, a dot while a release is owed. */
export function WhatsNewButton() {
  const t = useCopy();
  const entry = useWhatsNewEntry();
  return (
    <>
      <RailButton
        icon="star"
        label={t("whatsNew.nav")}
        ariaLabel={entry.owed ? `${t("whatsNew.nav")}, ${t("whatsNew.unread")}` : t("whatsNew.nav")}
        dot={entry.owed}
        dotTestId="whats-new-dot"
        tour="nav-whats-new"
        onClick={entry.open}
      />
      {entry.sheet}
    </>
  );
}
