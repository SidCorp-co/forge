import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cn(
        "w-full resize-y rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-fg",
        "placeholder:text-disabled disabled:cursor-not-allowed disabled:opacity-50",
        "transition-shadow focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
        "aria-[invalid=true]:border-[color:var(--red-500)] aria-[invalid=true]:focus-visible:border-[color:var(--red-500)]",
        className,
      )}
      {...props}
    />
  );
}
