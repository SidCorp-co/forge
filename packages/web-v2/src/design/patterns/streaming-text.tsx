import { cn } from "@/lib/utils/cn";

export interface StreamingTextProps {
  text: string;
  /** While true, a blinking caret trails the text (agent is still emitting). */
  streaming?: boolean;
  className?: string;
}

/** Renders agent output with a blinking caret while tokens are still arriving. */
export function StreamingText({ text, streaming, className }: StreamingTextProps) {
  return (
    <p className={cn("fg-body whitespace-pre-wrap", className)}>
      {text}
      {streaming && <span className="forge-caret" aria-hidden />}
    </p>
  );
}
