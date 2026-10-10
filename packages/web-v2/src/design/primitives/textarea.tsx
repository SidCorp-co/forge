import type { Ref, TextareaHTMLAttributes } from "react";
import { Textarea as ShadcnTextarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils/cn";
import { useFieldControl } from "./field";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
};

export function Textarea({ className, rows = 4, ...props }: TextareaProps) {
  const field = useFieldControl();
  return (
    <ShadcnTextarea
      {...field}
      rows={rows}
      className={cn(
        "field-sizing-fixed min-h-0 resize-y rounded-md border-line-strong bg-surface px-3 py-2 text-fg",
        "placeholder:text-disabled transition-shadow focus-visible:border-link focus-visible:ring-0 focus-visible:shadow-focus",
        "aria-[invalid=true]:border-danger-9 aria-[invalid=true]:ring-0",
        className,
      )}
      {...props}
    />
  );
}
