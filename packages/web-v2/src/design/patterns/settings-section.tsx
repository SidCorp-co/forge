import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * One section of a settings page: flat and flush with the page, no border, radius or shadow of its
 * own. What tells two sections apart is a hairline above the second and every one after it, and the
 * type and whitespace inside. The spacing between sections is the parent's (`space-y-6`).
 */
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
