"use client";

import { useEffect, type ReactNode } from "react";
import { Icon } from "@/design/icons/icon";

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
}

/** Right-hand drawer — context/detail (e.g. RunDetail) opens here rather than
    navigating away. Backdrop blur + slide-in from the right. */
export function SlideOver({ open, onClose, title, children, width = 480 }: SlideOverProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(24,27,34,0.25)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <aside
        className="forge-slide flex h-full flex-col border-l border-line bg-surface shadow-lg"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="fg-h3">{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-subtle hover:text-fg">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}
