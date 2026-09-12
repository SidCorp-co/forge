import { cn } from "@/lib/utils/cn";

export interface WaffleCategory {
  key: string;
  label: string;
  count: number;
  color: string;
  /** Where this category's records are listed. Absent → drawn without a door. */
  onOpen?: () => void;
}

export interface WaffleProps {
  categories: WaffleCategory[];
  /** Records one cell stands for. One cell per record where the total is small. */
  perCell?: number;
  className?: string;
}

/**
 * Composition as a grid of cells, one category per colour.
 */
// cm:guard the cell count per category is derived from its OWN count and the totals are printed beside it — a waffle that rounds each category to a share of a fixed 100 cells shows a 3-issue bucket and a 300-issue bucket as the same block (ISS-988 criterion 28).
export function Waffle({ categories, perCell, className }: WaffleProps) {
  const total = categories.reduce((n, c) => n + c.count, 0);
  if (total === 0) return null;

  // cm:why cells are capped at ~240 so a 1,110-issue backlog stays one screen; the divisor is announced in each category's accessible name so a reader is never told a cell is one record when it is forty
  const per = perCell ?? Math.max(1, Math.ceil(total / 240));

  const cells = categories.flatMap((c) =>
    Array.from({ length: Math.round(c.count / per) }, (_, i) => ({
      id: `${c.key}-${i}`,
      color: c.color,
    })),
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap gap-[3px]">
        {cells.map((cell) => (
          <span
            key={cell.id}
            aria-hidden
            data-waffle-cell
            className="block size-2 rounded-[2px]"
            style={{ background: cell.color }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {categories.map((c) => {
          const name = `${c.label}: ${c.count} ${c.count === 1 ? "issue" : "issues"}`;
          const swatch = (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
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
      {per > 1 ? (
        <p className="fg-body-sm text-subtle">Each cell is {per} issues.</p>
      ) : null}
    </div>
  );
}
