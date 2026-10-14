import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/** A flat settings section: no card chrome, a hairline above every one but the first. */
export function SettingsSection({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "[&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-6",
        className,
      )}
      {...props}
    />
  );
}
