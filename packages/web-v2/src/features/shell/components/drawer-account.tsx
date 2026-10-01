"use client";

import { Icon } from "@/design";

const ROW =
  "flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-13-5 font-semibold text-muted transition-colors hover:bg-hover hover:text-fg";

export function DrawerAccount({ onAccount, onSignOut }: { onAccount: () => void; onSignOut: () => void }) {
  return (
    <>
      <button type="button" className={ROW} onClick={onAccount}>
        <Icon name="settings" size={17} />
        Account &amp; Settings
      </button>
      <button type="button" className={ROW} onClick={onSignOut}>
        <Icon name="logOut" size={17} />
        Sign out
      </button>
    </>
  );
}
