import clsx from "clsx";
import { STATUS_COLORS } from "@/lib/constants";

const extraColors: Record<string, string> = {
  backlog: "bg-gray-100 text-gray-600",
  todo: "bg-blue-100 text-blue-700",
  in_review: "bg-purple-100 text-purple-700",
  done: "bg-green-100 text-green-700",
  enabled: "bg-green-100 text-green-700",
  disabled: "bg-gray-100 text-gray-500",
  idle: "bg-gray-100 text-gray-600",
  running: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

const allColors: Record<string, string> = { ...STATUS_COLORS, ...extraColors };

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-block rounded px-2 py-0.5 text-xs font-medium",
        allColors[status] ?? "bg-gray-100 text-gray-600",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
