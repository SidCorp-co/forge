
import { useEffect, useState } from "react";
import { RailButton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { closeAutoOpened, useAutoOpenedRelease, useMarkWhatsNewSeen, useWhatsNew, useWhatsNewSummary } from "../hooks";
import { WhatsNewSheet } from "./whats-new-panel";

export { forgetOpenedWhatsNew } from "../hooks";

/**
 * The rail's What's new entry, opened by itself once per release (REQ-40 BC-10: people see What's new
 * once per instance after a release reaches it). Where the summary says the serving release is owed,
 * it opens by itself (`hooks.ts:readSummary`); opening it reads the release and shows it as it stood.
 * Showing an owed release writes the mark that names it, so it is seen once whether the person closes
 * it, leaves it open, reloads or signs in again (ISS-1073: on dev.567 only a close wrote the mark, and
 * it opened on every page load until one did); the mark clears the dot and owes nothing more on it.
 * Opened by hand with nothing owed, it shows the release and writes nothing.
 */
export function WhatsNewButton({ compact = false }: { compact?: boolean }) {
  const t = useCopy();
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
