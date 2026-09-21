
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
