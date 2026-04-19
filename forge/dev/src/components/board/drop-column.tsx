import { useState, type DragEvent } from "react";
import clsx from "clsx";

interface DropColumnProps {
  label: string;
  color: string;
  bg: string;
  count: number;
  status: string;
  onDrop: (itemId: string, status: string) => void;
  children: React.ReactNode;
  dragType: "issueId" | "taskId";
}

export function DropColumn({ label, color, bg, count, status, onDrop, children, dragType }: DropColumnProps) {
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const itemId = e.dataTransfer.getData(dragType);
        if (itemId) onDrop(itemId, status);
      }}
      className={clsx(
        "min-w-[180px] flex-1 rounded-lg border-t-4 p-3 transition-colors",
        color, bg,
        over && "ring-2 ring-blue-400 ring-inset",
      )}
    >
      <h3 className="mb-3 flex items-center justify-between text-sm font-semibold">
        {label}
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-normal text-gray-500 shadow-sm">{count}</span>
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
