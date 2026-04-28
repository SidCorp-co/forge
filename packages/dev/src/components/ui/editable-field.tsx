import { useState } from "react";
import { Markdown } from "./markdown";

const PencilIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
  </svg>
);

interface EditableFieldProps {
  value: string | null | undefined;
  placeholder?: string;
  rows?: number;
  editTitle?: string;
  onSave: (value: string) => void;
}

export function EditableField({ value, placeholder = "Not defined yet", rows = 5, editTitle = "Edit", onSave }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
          }}
          rows={rows}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            onClick={() => { onSave(draft); setEditing(false); }}
            className="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="rounded px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative">
      {value ? (
        <Markdown>{value}</Markdown>
      ) : (
        <p className="text-sm text-gray-400 italic">{placeholder}</p>
      )}
      <button
        onClick={() => { setDraft(value || ""); setEditing(true); }}
        className="absolute -right-1 -top-1 rounded p-1 text-gray-400 opacity-0 hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"
        title={editTitle}
      >
        <PencilIcon />
      </button>
    </div>
  );
}
