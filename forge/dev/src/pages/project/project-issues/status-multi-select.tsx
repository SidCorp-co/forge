import { useState, useRef, useEffect } from "react";
import { ALL_STATUSES, STATUS_COLORS } from "@/lib/constants";
import type { IssueStatus } from "@/lib/types";

interface StatusMultiSelectProps {
  selected: IssueStatus[];
  onChange: (statuses: IssueStatus[]) => void;
}

export function StatusMultiSelect({ selected, onChange }: StatusMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggle(value: IssueStatus) {
    const next = selected.includes(value)
      ? selected.filter((s) => s !== value)
      : [...selected, value];
    onChange(next);
  }

  const label = selected.length === 0
    ? "All statuses"
    : selected.length === 1
      ? ALL_STATUSES.find((s) => s.value === selected[0])?.label ?? selected[0]
      : `${selected.length} statuses`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm min-w-[140px] justify-between ${
          selected.length > 0
            ? "border-gray-400 bg-gray-50 text-gray-900"
            : "border-gray-200 text-gray-500"
        }`}
        aria-label="Filter by status"
      >
        <span className="truncate">{label}</span>
        <span className="flex items-center gap-1">
          {selected.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange([]); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange([]); } }}
              className="rounded-full p-0.5 hover:bg-gray-200"
              aria-label="Clear status filter"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </span>
          )}
          <svg className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {ALL_STATUSES.map((s) => {
            const checked = selected.includes(s.value);
            return (
              <label
                key={s.value}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(s.value)}
                  className="h-3.5 w-3.5 rounded border-gray-300 accent-blue-600"
                />
                <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[s.value]}`}>
                  {s.label}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
