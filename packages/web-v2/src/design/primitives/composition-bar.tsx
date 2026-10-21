import { cn } from "@/lib/utils/cn";

export interface CompositionCategory {
  key: string;
  label: string;
  count: number;
  color: string;
  /** Where this category's records are listed. Absent → drawn without a door. */
  onOpen?: () => void;
}

export interface CompositionBarProps {
  categories: CompositionCategory[];
  className?: string;
}

/** Each category's share of the whole, as a bar spanning its width, with a counted legend. */
export function CompositionBar({ categories, className }: CompositionBarProps) {
  const total = categories.reduce((n, c) => n + c.count, 0);
  if (total === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div aria-hidden className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-sunken">
        {categories
          .filter((c) => c.count > 0)
          .map((c) => (
            <span
              key={c.key}
              data-composition-segment={c.key}
              className="block h-full"
              style={{ width: `${((c.count / total) * 100).toFixed(2)}%`, background: c.color }}
            />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {categories.map((c) => {
          const name = `${c.label}: ${c.count} ${c.count === 1 ? "issue" : "issues"}`;
          const swatch = (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-2"
              style={{ background: c.color }}
            />
          );
          const body = (
            <>
              {swatch}
              <span className="fg-body-sm text-muted">{c.label}</span>
              <span className="fg-body-sm tabular-nums">{c.count}</span>
            </>
          );
          return (
            <li key={c.key}>
              {c.onOpen ? (
                <button
                  type="button"
                  onClick={c.onOpen}
                  aria-label={`${name} — open the list`}
                  className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                  {body}
                </button>
              ) : (
                <span className="flex items-center gap-1.5 px-1 py-0.5">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
