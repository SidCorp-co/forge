"use client";

// The preview inside Forge (REQ-39 BC-3): an iframe on the preview host, entered with a one-minute
// ticket so the host sets its own viewer cookie, and "Open in tab" for a browser that holds back the
// cookie a framed page needs (Safari partitions it). The frame is sandboxed without top navigation;
// the preview host answers `frame-ancestors` for Forge's origin itself (core).

import type { PreviewRecord } from "@forge/contracts/preview";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { previewsApi } from "./api";

/** What the frame may do: run scripts as its own origin, post forms, open popups. Never navigate Forge. */
export const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

/** A framed page that has not loaded by now is probably held back by the browser, not slow. */
export const FRAME_SLOW_MS = 12_000;

export function PreviewFrame({ preview, issueLabel, height = 520 }: { preview: PreviewRecord; issueLabel: string; height?: number }) {
  const t = useCopy();
  const [src, setSrc] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [round, setRound] = useState(0);
  const [tabFailure, setTabFailure] = useState<unknown>(null);

  // A ticket is single-use: one per entry, and a new one whenever the frame is reloaded by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the reload trigger, not an input.
  useEffect(() => {
    let current = true;
    setSrc(null);
    setLoaded(false);
    setSlow(false);
    setFailure(null);
    previewsApi.ticketUrl(preview.id).then(
      (url) => current && setSrc(url),
      (err) => current && setFailure(err),
    );
    return () => {
      current = false;
    };
  }, [preview.id, preview.url, round]);

  useEffect(() => {
    if (!src || loaded) return;
    const timer = setTimeout(() => setSlow(true), FRAME_SLOW_MS);
    return () => clearTimeout(timer);
  }, [src, loaded]);

  const openInTab = useCallback(async () => {
    // opened before the ticket is asked for: a window opened after an await is a blocked popup
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setTabFailure(null);
    try {
      const url = await previewsApi.ticketUrl(preview.id);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (err) {
      tab?.close();
      setTabFailure(err);
    }
  }, [preview]);

  const problem = failure ?? tabFailure;
  return (
    <div data-testid="preview-frame">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <Button size="sm" variant="secondary" onClick={() => void openInTab()}>
          {t("previews.openInTab")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRound((n) => n + 1)}>
          {t("previews.reload")}
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="fg-body-sm pb-2" style={{ color: "var(--red-600)" }}>
          {t("previews.frame.ticketFailed")}: {formatApiError(problem)}
        </p>
      ) : null}
      {slow && !loaded ? (
        <p role="status" data-testid="preview-frame-slow" className="fg-body-sm pb-2 text-muted">
          {t("previews.frame.slow")}
        </p>
      ) : null}
      {src ? (
        <iframe
          key={src}
          src={src}
          title={t("previews.frame.title", { issue: issueLabel })}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          className="w-full rounded-md border border-line bg-surface"
          style={{ height }}
        />
      ) : problem ? null : (
        <p role="status" className="fg-body-sm text-muted">
          {t("previews.frame.entering")}
        </p>
      )}
    </div>
  );
}
