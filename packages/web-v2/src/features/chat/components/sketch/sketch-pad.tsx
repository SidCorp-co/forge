"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/design";
import type { SketchExport } from "./sketch-canvas";

const SketchCanvas = dynamic(() => import("./sketch-canvas"), {
  ssr: false,
  loading: () => <p className="fg-body-sm p-4 text-muted">Opening the sketch pad…</p>,
});

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
  const exporter = useRef<SketchExport | null>(null);
  const [state, setState] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null });
  const onReady = useCallback((fn: SketchExport | null) => {
    exporter.current = fn;
  }, []);

  const attach = async () => {
    if (!exporter.current) return;
    setState({ busy: true, said: null });
    try {
      const png = await exporter.current();
      if (!png) {
        setState({ busy: false, said: "Nothing is drawn yet." });
        return;
      }
      onAttach(new File([png], `sketch-${stamp()}.png`, { type: "image/png" }));
      setState({ busy: false, said: null });
      onClose();
    } catch (err) {
      setState({ busy: false, said: `The sketch could not be exported: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-testid="sketch-pad"
        className="flex h-[min(80vh,640px)] w-[min(92vw,880px)] max-w-none flex-col gap-2 p-3 sm:max-w-none"
      >
        <DialogTitle className="fg-body-sm font-semibold text-fg">Sketch</DialogTitle>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-line">
          {open && <SketchCanvas onReady={onReady} />}
        </div>
        <div className="flex flex-none items-center justify-end gap-2">
          {state.said && (
            <p role="status" className="fg-caption mr-auto text-muted">
              {state.said}
            </p>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="sm" loading={state.busy} onClick={attach}>
            Attach
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
