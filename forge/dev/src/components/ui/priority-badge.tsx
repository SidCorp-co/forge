import clsx from "clsx";
import type { IssuePriority } from "@/lib/types";
import { PRIORITY_COLORS } from "@/lib/constants";

export function PriorityBadge({ priority }: { priority: IssuePriority }) {
  return (
    <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-medium", PRIORITY_COLORS[priority])}>
      {priority}
    </span>
  );
}
