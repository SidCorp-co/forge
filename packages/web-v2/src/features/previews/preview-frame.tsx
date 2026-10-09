"use client";

// The preview inside Forge (REQ-39 BC-3): an iframe on the preview host, entered with a one-minute
// ticket so the host sets its own viewer cookie, and "Open in tab" for a browser that holds back the
// cookie a framed page needs. Safari keeps no third-party cookie at all: the frame then shows "Allow
// this preview" (core previews/gate.ts), and once the browser grants storage access it asks THIS page,
// its parent, for a fresh ticket (PREVIEW_FRAME_MESSAGES); a frame that cannot get its cookie says so
// and this page offers Open in tab. The frame is sandboxed without top navigation; the preview host
// answers `frame-ancestors` for Forge's origin itself (core).

import { PREVIEW_FRAME_MESSAGES, type PreviewRecord } from "@forge/contracts/preview";
import { type Ref, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { previewsApi } from "./api";

/**
 * What the frame may do: run scripts as its own origin, post forms, open popups, and ask the browser
 * for its cookie back (`allow-storage-access-by-user-activation`: without it `requestStorageAccess()`
 * is refused in a sandboxed frame). Never navigate Forge.
 */
export const PREVIEW_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-storage-access-by-user-activation";

/** A framed page that has not loaded by now is probably held back by the browser, not slow. */
export const FRAME_SLOW_MS = 12_000;

export function PreviewFrame({ preview, issueLabel, height = 520, frameRef }: { preview: PreviewRecord; issueLabel: string; height?: number; frameRef?: Ref<HTMLIFrameElement> }) {
  const t = useCopy();
  const [src, setSrc] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [round, setRound] = useState(0);
  const [tabFailure, setTabFailure] = useState<unknown>(null);
  const [cookieRefused, setCookieRefused] = useState(false);
  const iframe = useRef<HTMLIFrameElement | null>(null);
  const setIframe = useCallback(
    (el: HTMLIFrameElement | null) => {
      iframe.current = el;
      if (typeof frameRef === "function") frameRef(el);
      else if (frameRef) (frameRef as { current: HTMLIFrameElement | null }).current = el;
    },
    [frameRef],
  );

  // A ticket is single-use: one per entry, and a new one whenever the frame is reloaded by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the reload trigger, not an input.
  useEffect(() => {
    let current = true;
    setSrc(null);
    setLoaded(false);
    setSlow(false);
    setFailure(null);
    setCookieRefused(false);
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

  // The frame's two asks, taken from this preview's own frame window at its own origin and nobody else.
  useEffect(() => {
    const origin = new URL(preview.url).origin;
    const onMessage = (event: MessageEvent) => {
      const frame = iframe.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== origin) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === PREVIEW_FRAME_MESSAGES.ticketRequest) {
        previewsApi.ticketUrl(preview.id).then(
          (url) => frame.postMessage({ type: PREVIEW_FRAME_MESSAGES.ticket, url }, origin),
          (err) => setFailure(err),
        );
      } else if (type === PREVIEW_FRAME_MESSAGES.storageRefused) {
        setCookieRefused(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [preview.id, preview.url]);

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
        <Button size="sm" variant={cookieRefused ? "primary" : "secondary"} onClick={() => void openInTab()}>
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
      {cookieRefused ? (
        <p role="status" data-testid="preview-frame-cookie-refused" className="fg-body-sm pb-2 text-muted">
          {t("previews.frame.cookieRefused")}
        </p>
      ) : null}
      {slow && !loaded && !cookieRefused ? (
        <p role="status" data-testid="preview-frame-slow" className="fg-body-sm pb-2 text-muted">
          {t("previews.frame.slow")}
        </p>
      ) : null}
      {src ? (
        <iframe
          key={src}
          ref={setIframe}
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
