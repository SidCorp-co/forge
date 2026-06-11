// Canonical screen content container (ISS-359).
//
// Every web-v2 screen wraps its content in <PageContainer>: one shared wide
// column (max-width 1720px, from `design/draft-screen/09 Usage.html`) with
// consistent side padding, so no screen hand-rolls its own `mx-auto max-w-*`
// wrapper. The legacy `standard` (max-w-6xl) option is gone — all screens are
// migrated.
//
// `ScreenTabs` uses the same default width so tab strips align with the body.

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export type PageContainerProps = HTMLAttributes<HTMLDivElement>;

export function PageContainer({ className, children, ...props }: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[1720px] px-4 py-6 sm:px-8 sm:py-8",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
