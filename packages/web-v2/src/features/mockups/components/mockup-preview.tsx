import { BoardCanvas } from "@/features/board";
import type { MockupKind } from "@forge/contracts/mockups";
import { parseWireframe } from "@forge/contracts/wireframe";
import { useEffect, useMemo } from "react";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useMockupBytes, useMockupText } from "../hooks";
import { isolatedSrcDoc, MOCKUP_FRAME_SANDBOX } from "../isolation";

function useObjectUrl(blob: Blob | undefined) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

/**
 * An HTML mockup running isolated from Forge (REQ-49 BC-1): its scripts run, it reaches no Forge
 * session, cookie or data (`../isolation.ts`). It fills the box it is given.
 */
export function MockupFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const doc = useMemo(() => isolatedSrcDoc(html), [html]);
  return (
    <iframe
      title={title}
      sandbox={MOCKUP_FRAME_SANDBOX}
      srcDoc={doc}
      referrerPolicy="no-referrer"
      className={cn("block h-full w-full border-0 bg-white", className)}
      data-testid="mockup-html"
    />
  );
}

const textual = (kind: MockupKind) => kind !== "image" && kind !== "sketch";

/** A mockup's bytes drawn as its kind takes them, filling the box it is given. */
export function MockupBody({ url, kind, name }: { url: string; kind: MockupKind; name: string }) {
  const t = useCopy();
  const bytes = useMockupBytes(url, !textual(kind));
  const image = useObjectUrl(bytes.data);
  const text = useMockupText(url, textual(kind));
  const board = useMemo(() => {
    if (kind !== "wireframe" || text.data === undefined) return null;
    try {
      return parseWireframe(JSON.parse(text.data));
    } catch {
      return null;
    }
  }, [kind, text.data]);
  const failed = bytes.error ?? text.error;
  if (failed) return <p className="p-3 text-13 text-muted">{formatApiError(failed)}</p>;
  if (!textual(kind)) {
    if (!image) return <p className="p-3 text-13 text-muted">{t("common.mockups.loading")}</p>;
    // a blob URL of a stored mockup: its size is its own
    return <img src={image} alt={name} className="mx-auto block h-full max-h-full w-auto max-w-full object-contain" data-testid="mockup-image" />;
  }
  if (text.data === undefined) return <p className="p-3 text-13 text-muted">{t("common.mockups.loading")}</p>;
  if (kind === "html") return <MockupFrame html={text.data} title={name} />;
  if (kind === "wireframe") {
    if (!board?.ok) return <p className="p-3 text-13 text-muted">{t("common.mockups.unreadable")}</p>;
    return (
      <div className="h-full" data-testid="mockup-board">
        <BoardCanvas doc={board.doc} />
      </div>
    );
  }
  let shown = text.data;
  try {
    shown = JSON.stringify(JSON.parse(text.data), null, 2);
  } catch {
    shown = text.data;
  }
  return <pre className="h-full overflow-auto bg-sunken p-3 font-mono text-12 leading-relaxed">{shown}</pre>;
}

/**
 * A mockup inline, as a row or a peek mounts it (REQ-49 BC-7): `url` is the route serving its bytes
 * (`MockupView.url`, or an approval row's `mockup.url`). An HTML page runs, isolated.
 */
export function MockupPreview({
  url,
  kind,
  name,
  className,
  onOpen,
}: {
  url: string;
  kind: MockupKind;
  name: string;
  className?: string;
  /** Opens it full screen; shown as a button over the preview when given. */
  onOpen?: () => void;
}) {
  const t = useCopy();
  return (
    <div className={cn("relative h-105 overflow-hidden border border-line-subtle bg-surface", className)} data-testid="mockup-preview">
      <MockupBody url={url} kind={kind} name={name} />
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="absolute top-2 right-2 rounded-sm border border-line bg-surface px-2 py-1 text-12 font-medium text-fg hover:bg-hover focus-visible:shadow-focus focus-visible:outline-none"
          data-testid="mockup-open-full"
        >
          {t("common.mockups.fullScreen")}
        </button>
      ) : null}
    </div>
  );
}
