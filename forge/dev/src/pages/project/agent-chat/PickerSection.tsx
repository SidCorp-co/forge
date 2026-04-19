const hoverCardClass = "rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-blue-400 hover:shadow-sm";

export function PickerSection<T extends { documentId: string; title: string }>({
  title, items, onSelect, renderMeta,
}: {
  title: string; items: T[]; onSelect: (item: T) => void; renderMeta: (item: T) => string;
}) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-gray-500">{title}</h2>
      <div className="space-y-2">
        {items.map((item) => (
          <button key={item.documentId} onClick={() => onSelect(item)}
            className={`flex w-full items-center justify-between text-left ${hoverCardClass}`}>
            <div>
              <p className="text-sm font-medium text-gray-900">{item.title}</p>
              <p className="mt-0.5 text-xs text-gray-500">{renderMeta(item)}</p>
            </div>
            <span className="text-xs text-blue-600">Select &rarr;</span>
          </button>
        ))}
      </div>
    </div>
  );
}
