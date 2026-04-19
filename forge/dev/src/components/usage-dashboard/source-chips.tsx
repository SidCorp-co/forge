export function SourceChips({
  sources,
  active,
  onToggle,
}: {
  sources: { source: string }[];
  active: Set<string>;
  onToggle: (s: string) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {sources.map((s) => {
        const on = active.has(s.source);
        return (
          <button
            key={s.source}
            onClick={() => onToggle(s.source)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize transition-all ${
              on
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:text-gray-600"
            }`}
          >
            {s.source}
          </button>
        );
      })}
    </div>
  );
}
