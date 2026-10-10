
import { useState } from "react";
import { RailButton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAutoOpenedRelease, useMarkWhatsNewSeen, useWhatsNew, useWhatsNewSummary } from "../hooks";
import { WhatsNewSheet } from "./whats-new-panel";

export { forgetOpenedWhatsNew } from "../hooks";

/**
 * The rail's What's new entry. Where the summary says the serving release is owed, it opens by itself
 * once (a dot stands until then); opening it reads the release and shows it as it stood. Closing it
 * on an owed release writes the mark that names that release, which clears the dot and owes nothing
 * more on it. Opened by hand with nothing owed, it shows the release and writes nothing.
 */
export function WhatsNewButton({ compact = false }: { compact?: boolean }) {
  const t = useCopy();
  const summary = useWhatsNewSummary();
  const { mutate: writeMark } = useMarkWhatsNewSeen();
  const autoOpened = useAutoOpenedRelease();
  // opened by hand: when, so only a read taken since shows; closed: on which auto-opened release
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const open = openedAt !== null || (autoOpened !== null && autoOpened !== closedOn);
  const feedQ = useWhatsNew(open);
  // the release as it stood when the panel opened: never an earlier read, nor the mark the close writes
  const shown = open && feedQ.data && feedQ.dataUpdatedAt >= (openedAt ?? 0) ? feedQ.data : undefined;
  const failure = open && feedQ.error ? "failed" : null;
  const owed = summary.data?.release?.owed === true;

  function closePanel() {
    setOpenedAt(null);
    setClosedOn(autoOpened);
    if (shown?.release?.owed) writeMark({ environment: shown.environment, version: shown.release.version });
  }

  return (
    <>
      <RailButton
        icon="star"
        label={t("whatsNew.nav")}
        ariaLabel={owed ? `${t("whatsNew.nav")}, ${t("whatsNew.unread")}` : t("whatsNew.nav")}
        dot={owed}
        dotTestId="whats-new-dot"
        compact={compact}
        tour="nav-whats-new"
        onClick={() => setOpenedAt(Date.now())}
      />
      <WhatsNewSheet open={open} onClose={closePanel} feed={shown} failure={failure} loading={open && !shown && !failure} />
    </>
  );
}
