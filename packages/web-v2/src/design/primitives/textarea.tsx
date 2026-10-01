import type { Ref, TextareaHTMLAttributes } from "react";
import { Textarea as ShadcnTextarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils/cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
};

export function Textarea({ className, rows = 4, ...props }: TextareaProps) {
  return (
    <ShadcnTextarea
      rows={rows}
      className={cn(
        "field-sizing-fixed min-h-0 resize-y rounded-md border-line-strong bg-surface px-3 py-2 text-fg",
        "placeholder:text-disabled transition-shadow focus-visible:border-[color:var(--link)] focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus)]",
        "aria-[invalid=true]:border-[color:var(--red-500)] aria-[invalid=true]:ring-0",
        className,
      )}
      {...props}
    />
  );
}
