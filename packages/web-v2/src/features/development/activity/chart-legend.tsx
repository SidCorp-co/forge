// The legend under or beside an activity chart: a swatch, the series, its value and, where it has
// one, its share. The swatch colour is the series' own, the data.

interface LegendRow {
  key: string;
  color: string;
  label: string;
  value: string;
  share?: string;
}

export function ChartLegend({ rows, columns = 1 }: { rows: LegendRow[]; columns?: 1 | 2 }) {
  return (
    <ul className={columns === 2 ? "grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-1.5" : "min-w-0 flex-1 space-y-1.5"}>
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-2">
          <span className="size-2.5 flex-none rounded-xs" style={{ background: r.color }} />
          <span className="min-w-0 flex-1 truncate text-13 text-fg">{r.label}</span>
          <span className="font-mono text-13 font-semibold tabular-nums text-fg">{r.value}</span>
          {r.share ? <span className="w-10 text-right text-12 tabular-nums text-subtle">{r.share}</span> : null}
        </li>
      ))}
    </ul>
  );
}
