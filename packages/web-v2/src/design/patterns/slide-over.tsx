"use client";

import type { CSSProperties, ReactNode } from "react";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Icon } from "@/design/icons/icon";

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number | string;
  fitBody?: boolean;
  hideHeader?: boolean;
}

export function SlideOver({
  open,
  onClose,
  title,
  children,
  width = 480,
  fitBody = false,
  hideHeader = false,
}: SlideOverProps) {
  const slideOverWidth = typeof width === "number" ? `${width}px` : width;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 border-line bg-surface text-fg data-[side=right]:w-full data-[side=right]:max-w-[100vw] data-[side=right]:sm:w-[var(--slide-over-w)] data-[side=right]:sm:max-w-[100vw]"
        style={{ "--slide-over-w": slideOverWidth } as CSSProperties}
      >
        {hideHeader ? (
          <SheetTitle className="sr-only">{title}</SheetTitle>
        ) : (
          <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-5 py-4">
            <SheetTitle className="fg-h3">{title}</SheetTitle>
            <SheetClose
              aria-label="Close"
              className="rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <Icon name="x" size={18} />
            </SheetClose>
          </header>
        )}
        {fitBody ? (
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        )}
      </SheetContent>
    </Sheet>
  );
}
