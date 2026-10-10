"use client";

// The preview inside Forge (REQ-39 BC-3): an iframe on the preview host, entered with a one-minute
// ticket so the host sets its own viewer cookie, and "Open in tab" for a browser that holds back the
// cookie a framed page needs. Safari keeps no third-party cookie at all: the frame then shows "Allow
// this preview" (core previews/gate.ts), and once the browser grants storage access it asks THIS page,
// its parent, for a fresh ticket (PREVIEW_FRAME_MESSAGES); a frame that cannot get its cookie says so
// and this page offers Open in tab. The frame is sandboxed without top navigation; the preview host
// answers `frame-ancestors` for Forge's origin itself (core).

import { PREVIEW_FRAME_MESSAGES, type PreviewRecord } from "@forge/contracts/preview";
import { useQuery } from "@tanstack/react-query";
import { type Ref, useEffect, useRef, useState } from "react";
import { Button } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { previewsApi } from "../api";
import { previewQueries } from "../queries";

/**
 * What the frame may do: run scripts as its own origin, post forms, open popups, and ask the browser
 * for its cookie back (`allow-storage-access-by-user-activation`: without it `requestStorageAccess()`
 * is refused in a sandboxed frame). Never navigate Forge.
 */
export const PREVIEW_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-storage-access-by-user-activation";

/** A framed page that has not loaded by now is probably held back by the browser, not slow. */
export const FRAME_SLOW_MS = 12_000;

/** Opens the preview in its own tab, entered with a ticket; throws what the ticket's read refused with. */
export async function openPreviewInTab(previewId: string): Promise<void> {
  // opened before the ticket is asked for: a window opened after an await is a blocked popup
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const url = await previewsApi.ticketUrl(previewId);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

type FrameProps = { preview: PreviewRecord; issueLabel: string; height?: number; frameRef?: Ref<HTMLIFrameElement> };

/** A reload by hand enters again from nothing: the entry below is keyed by the preview and the round. */
export function PreviewFrame(props: FrameProps) {
  const [round, setRound] = useState(0);
  return <FrameEntry key={`${props.preview.id}|${props.preview.url}|${round}`} {...props} round={round} onReload={() => setRound((n) => n + 1)} />;
}

function FrameEntry({ preview, issueLabel, height = 520, frameRef, round, onReload }: FrameProps & { round: number; onReload: () => void }) {
  const t = useCopy();
  // a ticket is single-use: one per entry, read once and never cached past it
  const ticket = useQuery(previewQueries.ticket(preview.id, round));
  const src = ticket.data ?? null;
  const [failure, setFailure] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [tabFailure, setTabFailure] = useState<unknown>(null);
  const [cookieRefused, setCookieRefused] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const setIframe = (el: HTMLIFrameElement | null) => {
    iframeRef.current = el;
    if (typeof frameRef === "function") frameRef(el);
    else if (frameRef) (frameRef as { current: HTMLIFrameElement | null }).current = el;
  };

  useEffect(() => {
    if (!src || loaded) return;
    const timer = setTimeout(() => setSlow(true), FRAME_SLOW_MS);
    return () => clearTimeout(timer);
  }, [src, loaded]);

  // The frame's two asks, taken from this preview's own frame window at its own origin and nobody else.
  useEffect(() => {
    const origin = new URL(preview.url).origin;
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== origin) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === PREVIEW_FRAME_MESSAGES.ticketRequest) {
        previewsApi.ticketUrl(preview.id).then(
          (url) => frame.postMessage({ type: PREVIEW_FRAME_MESSAGES.ticket, url }, origin),
          (err: unknown) => setFailure(err),
        );
      } else if (type === PREVIEW_FRAME_MESSAGES.storageRefused) {
        setCookieRefused(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [preview.id, preview.url]);

  const openInTab = async () => {
    setTabFailure(null);
    try {
      await openPreviewInTab(preview.id);
    } catch (err) {
      setTabFailure(err);
    }
  };

  const problem = ticket.error ?? failure ?? tabFailure;
  return (
    <div data-testid="preview-frame">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <Button size="sm" variant={cookieRefused ? "primary" : "secondary"} onClick={() => void openInTab()}>
          {t("previews.openInTab")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onReload}>
          {t("previews.reload")}
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="pb-2 text-13 text-danger-11">
          {t("previews.frame.ticketFailed")}: {formatApiError(problem)}
        </p>
      ) : null}
      {cookieRefused ? (
        <p role="status" data-testid="preview-frame-cookie-refused" className="pb-2 text-13 text-muted">
          {t("previews.frame.cookieRefused")}
        </p>
      ) : null}
      {slow && !loaded && !cookieRefused ? (
        <p role="status" data-testid="preview-frame-slow" className="pb-2 text-13 text-muted">
          {t("previews.frame.slow")}
        </p>
      ) : null}
      {src ? (
        <iframe
          ref={setIframe}
          src={src}
          title={t("previews.frame.title", { issue: issueLabel })}
          // eslint-disable-next-line @eslint-react/dom-no-unsafe-iframe-sandbox -- preview runs on a separate preview origin; allow-same-origin is required for its cookie and grants no access to the app origin
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          className="w-full border border-line bg-surface"
          style={{ height }}
        />
      ) : problem ? null : (
        <p role="status" className="text-13 text-muted">
          {t("previews.frame.entering")}
        </p>
      )}
    </div>
  );
}
