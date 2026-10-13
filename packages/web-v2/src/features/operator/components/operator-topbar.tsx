
import { HealthDot, IconButton, Kicker, Menu, Tooltip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { OperatorSectionKey } from "../types";

const STATUS_PILLS = ["db", "queue", "ws"] as const;

function StatusPill({ pill }: { pill: string }) {
  const note = `${pill.toUpperCase()} health checks aren't wired up yet`;
  return (
    <Tooltip label={note}>
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-line px-2 py-1">
        <span className="fg-overline">{pill}</span>
        <HealthDot health="idle" />
        <span className="sr-only">{note}</span>
      </span>
    </Tooltip>
  );
}

function AccountMenu({ onAccount, onSignOut }: { onAccount: () => void; onSignOut: () => void }) {
  const t = useCopy();
  return (
    <Menu
      className="md:hidden"
      items={[
        { label: t("operator.topbar.account"), icon: "settings", onSelect: onAccount },
        { label: t("operator.topbar.signOut"), icon: "logOut", danger: true, onSelect: onSignOut },
      ]}
      trigger={<IconButton icon="more" size="sm" aria-label={t("operator.topbar.accountMenu")} />}
    />
  );
}

/** Operator-owned header — `@/design` TopBar bakes an unconditional "New
 *  issue" CTA with no slot for these health pills, so this console gets its
 *  own header built from primitives instead (ISS-650 plan decision 5). */
export function OperatorTopbar({
  section,
  onAccount,
  onSignOut,
}: {
  section: OperatorSectionKey;
  onAccount: () => void;
  onSignOut: () => void;
}) {
  const t = useCopy();
  const label = t(`operator.section.${section}`);
  return (
    <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-5">
      <Kicker>{t("operator.topbar.kicker")}</Kicker>
      <span className="fg-h3">{label}</span>
      <div className="ml-auto flex items-center gap-2">
        <div className="hidden items-center gap-2 sm:flex">
          {STATUS_PILLS.map((key) => (
            <StatusPill key={key} pill={key} />
          ))}
        </div>
        <AccountMenu onAccount={onAccount} onSignOut={onSignOut} />
      </div>
    </header>
  );
}
