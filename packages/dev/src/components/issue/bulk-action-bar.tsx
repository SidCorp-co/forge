import { useState } from "react";
import { FormSelect } from "@/components/ui/form-input";
import { ALL_STATUSES, ALL_PRIORITIES, ALL_CATEGORIES } from "@/lib/constants";
import type { Issue } from "@/lib/types";

interface BulkActionBarProps {
  count: number;
  onApply: (data: Partial<Issue>) => void;
  onClear: () => void;
}

export function BulkActionBar({ count, onApply, onClear }: BulkActionBarProps) {
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [category, setCategory] = useState("");

  function handleApply() {
    const fields: { key: keyof Issue; value: string; list: { value: string; label: string }[]; label: string }[] = [
      { key: "status", value: status, list: ALL_STATUSES, label: "Status" },
      { key: "priority", value: priority, list: ALL_PRIORITIES, label: "Priority" },
      { key: "category", value: category, list: ALL_CATEGORIES, label: "Category" },
    ];

    const active = fields.filter((f) => f.value);
    if (active.length === 0) return;

    const changes: Partial<Issue> = {};
    const parts: string[] = [];
    for (const f of active) {
      (changes as Record<string, string>)[f.key] = f.value;
      parts.push(`${f.label} → ${f.list.find((o) => o.value === f.value)?.label}`);
    }

    if (!window.confirm(`Update ${count} issue${count !== 1 ? "s" : ""}?\n\n${parts.join("\n")}`)) return;

    onApply(changes);
    setStatus("");
    setPriority("");
    setCategory("");
  }

  return (
    <div className="sticky bottom-4 z-10 mx-auto mt-3 flex w-fit items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium text-gray-700">{count} selected</span>
      <div className="mx-1 h-5 w-px bg-gray-200" />

      <FormSelect value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto !py-1.5 !text-xs">
        <option value="">Status...</option>
        {ALL_STATUSES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </FormSelect>

      <FormSelect value={priority} onChange={(e) => setPriority(e.target.value)} className="!w-auto !py-1.5 !text-xs">
        <option value="">Priority...</option>
        {ALL_PRIORITIES.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </FormSelect>

      <FormSelect value={category} onChange={(e) => setCategory(e.target.value)} className="!w-auto !py-1.5 !text-xs">
        <option value="">Category...</option>
        {ALL_CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </FormSelect>

      <button
        onClick={handleApply}
        disabled={!status && !priority && !category}
        className="rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-30"
      >
        Apply
      </button>

      <button onClick={onClear} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
  );
}
