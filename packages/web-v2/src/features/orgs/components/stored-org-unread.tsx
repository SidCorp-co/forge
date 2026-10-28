"use client";

import { RetryButton } from "@/design";
import { asSentence, formatApiError } from "@/lib/api/error";
import { useActiveOrg } from "../active-org";
import { workspaceName } from "../workspace-name";

/** Where the organization last worked in could not be read, every workspace page says so and names the one shown
 *  in its place: the stand-in is never a silent switch (ISS-1229 r50, judge-152 on criterion 451). */
export function StoredOrgUnread() {
  const { storedUnread, activeOrg } = useActiveOrg();
  if (!storedUnread) return null;
  const shown = activeOrg ? workspaceName(activeOrg) : null;
  return (
    <div
      data-testid="stored-org-unread"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunken px-4 py-2 sm:px-6"
    >
      <p role="alert" className="fg-body-sm min-w-0 text-fg">
        {storedOrgUnreadWords(shown)} <span className="text-muted">{asSentence(formatApiError(storedUnread.error))}</span>
      </p>
      <RetryButton error={storedUnread.error} onRetry={storedUnread.retry} />
    </div>
  );
}

/** What the line says: the read that failed, and the organization standing in for the one chosen. */
export function storedOrgUnreadWords(shown: string | null): string {
  return shown
    ? `Couldn't load which organization you were working in, so ${shown} is shown until it loads or you pick one.`
    : "Couldn't load which organization you were working in.";
}
