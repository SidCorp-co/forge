import { cn } from "@/lib/utils/cn";

export interface TruncatedProps {
  /** The whole text. It is drawn on one line, and is the element's title when the line cuts it off. */
  text: string;
  className?: string;
}

/**
 * A name that has less room than it needs, on one line, with an ellipsis where it is cut and the whole of
 * it in the title. The alternative, breaking the text wherever it runs out of room, breaks it mid-word.
 */
export function Truncated({ text, className }: TruncatedProps) {
  return (
    <span title={text} className={cn("block min-w-0 truncate", className)}>
      {text}
    </span>
  );
}
