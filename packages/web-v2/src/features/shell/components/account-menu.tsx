import type { MenuItem } from "@/design";
import { useHelpTours } from "@/features/tours";
import { ForgeVersion } from "@/features/version";
import { useWhatsNewEntry } from "@/features/whats-new";
import { useCopy } from "@/lib/i18n/interface-language";

/**
 * The account chip's menu beyond Account and Sign out: What's new, Help and the guides, each with its
 * dot, and the version as its last line (ISS-1331); the chip's dot says one of them holds something new.
 * Their sheets mount beside the rail, so a menu that closes never takes an open sheet with it.
 */
export function useAccountMenu(onRoute: (href: string) => void) {
  const t = useCopy();
  const whatsNew = useWhatsNewEntry();
  const help = useHelpTours();
  const unread = whatsNew.owed ? t("whatsNew.unread") : undefined;
  const changed = help.updated ? t("help.updated") : undefined;
  const menu: MenuItem[] = [
    { label: t("whatsNew.nav"), icon: "star", onSelect: whatsNew.open, dot: unread, separatorBefore: true },
    { label: t("help.nav"), icon: "help", onSelect: help.open, dot: changed },
    { label: t("shell.docs"), icon: "book", onSelect: () => onRoute("/docs") },
  ];
  const sheets = (
    <>
      {whatsNew.sheet}
      {help.sheet}
    </>
  );
  return { menu, dot: unread ?? changed, version: <ForgeVersion />, sheets };
}
