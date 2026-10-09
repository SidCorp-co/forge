"use client";

import { SlideOver } from "@/design";
import { ReleaseHighlightsSection } from "@/features/releases/components/release-highlights";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import type { WhatsNewChange, WhatsNewFeed } from "../types";

function Change({ change, kindLabel }: { change: WhatsNewChange; kindLabel: string }) {
  return (
    <li className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2.5 border-b border-line py-2.5" data-testid="whats-new-change">
      <span className={cn("pt-0.5 text-11 uppercase tracking-[0.05em]", change.kind === "new" ? "font-semibold text-accent-text" : "text-subtle")}>
        {kindLabel}
      </span>
      <span className="text-13-5 text-fg">{change.line}</span>
    </li>
  );
}

interface WhatsNewPanelProps {
  open: boolean;
  onClose: () => void;
  /** The release as it stood when the panel opened. */
  feed: WhatsNewFeed | undefined;
  failure: "failed" | null;
  /** The release is being read: it is read when the panel opens, never with the page. */
  loading?: boolean;
}

/** What's new: the release this instance serves, its highlights first, then its lines. */
export function WhatsNewPanel({ open, onClose, feed, failure, loading = false }: WhatsNewPanelProps) {
  const t = useCopy();
  const locale = useCopyLocale();
  const release = feed?.release ?? null;
  const released = release?.releasedAt ? new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(release.releasedAt)) : null;

  return (
    <SlideOver open={open} onClose={onClose} title={t("whatsNew.title")} width={440}>
      <div className="-mt-3" data-testid="whats-new-panel">
        {failure && <p className="pt-3 text-13 text-muted">{t("whatsNew.failed")}</p>}
        {loading && (
          <p className="pt-3 text-13 text-muted" data-testid="whats-new-loading">
            {t("whatsNew.loading")}
          </p>
        )}
        {feed && !release && (
          <p className="pt-4 text-13 text-muted" data-testid="whats-new-none">
            {t("whatsNew.none", { environment: feed.environment })}
          </p>
        )}
        {feed && release && (
          <>
            <p className="pb-1.5 pt-3 text-13 text-muted" data-testid="whats-new-release">
              <span className="font-semibold text-fg">{t("whatsNew.release", { version: release.version })}</span>
              {released ? <> · {released}</> : null}
            </p>
            <ReleaseHighlightsSection highlights={release.highlights} authed={false} />
            {release.changes.length > 0 && (
              <ul className="mt-2" data-testid="whats-new-changes">
                {release.changes.map((c) => (
                  <Change key={`${c.kind}:${c.line}`} change={c} kindLabel={t(`whatsNew.kind.${c.kind}`)} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </SlideOver>
  );
}
