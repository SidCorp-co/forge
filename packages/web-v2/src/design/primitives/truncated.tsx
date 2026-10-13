import { cn } from "@/lib/utils/cn";

export interface TruncatedProps {
  text: string;
  className?: string;
}

/** One line, an ellipsis where it is cut, the whole text in the title: never broken mid-word. */
export function Truncated({ text, className }: TruncatedProps) {
  return (
    <span title={text} className={cn("block min-w-0 truncate", className)}>
      {text}
    </span>
  );
}
