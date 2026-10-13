
import { Suspense, lazy, useCallback, useRef, useState } from "react";
import { Button, Dialog } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { SketchExport } from "./sketch-canvas";

const SketchCanvas = lazy(() => import("./sketch-canvas"));

function Opening() {
  const t = useCopy();
  return <p className="fg-body-sm p-4 text-muted">{t("chat.sketch.opening")}</p>;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/**
 * The person's sketch pad, opened from the composer beside Attach files: whatever they draw rides the
 * outgoing message as a PNG, staged exactly like a picked file.
 */
export function SketchPad({
  open,
  onClose,
  onAttach,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: (file: File) => void;
}) {
  const t = useCopy();
  const exporterRef = useRef<SketchExport | null>(null);
  const [state, setState] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null });
  const onReady = useCallback((fn: SketchExport | null) => {
    exporterRef.current = fn;
  }, []);

  const attach = async () => {
    if (!exporterRef.current) return;
    setState({ busy: true, said: null });
    try {
      const png = await exporterRef.current();
      if (!png) {
        setState({ busy: false, said: t("chat.sketch.nothing") });
        return;
      }
      onAttach(new File([png], `sketch-${stamp()}.png`, { type: "image/png" }));
      setState({ busy: false, said: null });
      onClose();
    } catch (err) {
      setState({ busy: false, said: t("chat.sketch.exportFailed", { error: err instanceof Error ? err.message : String(err) }) });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("chat.sketch.title")}
      width="lg"
      testId="sketch-pad"
      footer={
        <>
          {state.said ? (
            <p role="status" className="fg-caption mr-auto text-muted">
              {state.said}
            </p>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" size="sm" loading={state.busy} onClick={() => void attach()}>
            {t("chat.sketch.attach")}
          </Button>
        </>
      }
    >
      <div className="h-120 min-h-0 overflow-hidden border border-line">{open && (
          <Suspense fallback={<Opening />}>
            <SketchCanvas onReady={onReady} />
          </Suspense>
        )}</div>
    </Dialog>
  );
}
