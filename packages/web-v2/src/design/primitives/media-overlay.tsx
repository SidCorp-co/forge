"use client";

// A full-screen overlay for media (an image gallery, a recording): Base UI Dialog parts as documented,
// so the focus trap, Escape, focus return and scroll lock are the primitive's. The feature draws the
// stage inside; a press on the dimmed backdrop closes it.

import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

export interface MediaOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What assistive tech reads for the overlay. */
  label: string;
  children: ReactNode;
}

export function MediaOverlay({ open, onOpenChange, label, children }: MediaOverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-(--scrim-media) backdrop-blur-sm" />
        <Dialog.Popup aria-label={label} className="fixed inset-0 z-60 flex flex-col outline-none">
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
