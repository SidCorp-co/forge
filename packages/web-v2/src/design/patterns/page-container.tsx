// Canonical screen content container (ISS-359).
//
// Most web-v2 screens hand-roll `mx-auto w-full max-w-6xl px-4 py-6 sm:px-8`,
// which caps content at 1152px and leaves wide monitors with large empty side
// gutters. The redesign draft (`design/draft-screen/09 Usage.html`) introduced a
// much wider content column (`max-width:1720px`) with consistent side padding.
//
// This is the single knob for that migration: wrap a screen's content in
// <PageContainer> and pick `width`. Screens are migrated GRADUALLY — new or
// touched screens opt into `width="wide"`; we deliberately do NOT mass-rewrite
// every existing screen in one change (scope/regression risk). `standard`
// reproduces the legacy max-w-6xl column so an unmigrated screen can adopt the
// container without changing its visual width.
//
// Mirrors the `width` prop convention already used by `ScreenTabs`.

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  /** Content column width.
   *  - `standard` → legacy max-w-6xl (1152px), for unmigrated screens.
   *  - `wide`     → max-w-[1720px] (draft value), fills wide viewports. */
  width?: "standard" | "wide";
}

export function PageContainer({
  width = "wide",
  className,
  children,
  ...props
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-8 sm:py-8",
        width === "wide" ? "max-w-[1720px]" : "max-w-6xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
