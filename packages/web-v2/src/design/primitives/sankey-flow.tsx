import { cn } from "@/lib/utils/cn";

export interface SankeyNode {
  key: string;
  label: string;
  count: number;
  /** Median seconds one of these took, or null where none finished. */
  medianSeconds: number | null;
  /** True where this node feeds back into the run rather than forward out of it. */
  loop?: boolean;
}

export interface SankeyFlowProps {
  nodes: SankeyNode[];
  /** Sentence a reader who cannot see the drawing gets instead. */
  label: string;
  formatDuration: (seconds: number | null) => string;
  className?: string;
}

/**
 * The pipeline drawn as what flows through each of its job types.
 */
// cm:guard a `loop` node is drawn on its OWN path back into the chain and never as one more link in it: `fix` is work that re-enters the pipeline, and laying it inline says the pipeline has one more forward stage than it does (ISS-988 criterion 38).
// cm:guard the same figures are carried in the table below the drawing rather than in a tooltip — a tooltip is not an equivalent for a reader who cannot see the drawing, and criterion 38 asks for the figures in text (ISS-988).
export function SankeyFlow({ nodes, label, formatDuration, className }: SankeyFlowProps) {
  if (nodes.length === 0) return null;

  const forward = nodes.filter((n) => !n.loop);
  const loops = nodes.filter((n) => n.loop);
  const max = Math.max(1, ...nodes.map((n) => n.count));

  const width = 640;
  const height = 96;
  const slot = forward.length > 0 ? width / forward.length : width;
  const barW = Math.max(4, slot * 0.5);
  const mid = 34;

  return (
    <figure className={cn("m-0 flex w-full flex-col gap-3", className)}>
      {forward.length > 0 ? (
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block h-24 w-full"
        >
          <title>{label}</title>
          {forward.map((n, i) => {
            const h = Math.max(3, (n.count / max) * 44);
            const x = i * slot + (slot - barW) / 2;
            return (
              <g key={n.key}>
                {i > 0 ? (
                  <line
                    x1={(i - 1) * slot + (slot + barW) / 2}
                    y1={mid}
                    x2={x}
                    y2={mid}
                    stroke="var(--border-default)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                <rect
                  x={x}
                  y={mid - h / 2}
                  width={barW}
                  height={h}
                  rx={2}
                  fill="var(--accent)"
                  opacity={0.85}
                />
              </g>
            );
          })}
          {loops.length > 0 && forward.length > 1
            ? (() => {
                const from = (forward.length - 1) * slot + slot / 2;
                const to = slot / 2;
                return (
                  <path
                    d={`M${from},${mid + 26} C${from},${height - 6} ${to},${height - 6} ${to},${mid + 26}`}
                    fill="none"
                    stroke="var(--amber-500)"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })()
            : null}
        </svg>
      ) : null}
      <table className="w-full">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="fg-body-sm text-subtle">
            <th scope="col" className="text-left font-normal">Stage</th>
            <th scope="col" className="text-right font-normal">Jobs</th>
            <th scope="col" className="text-right font-normal">Median</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.key} className="fg-body-sm">
              <td className="py-0.5 text-left">
                {n.label}
                {n.loop ? <span className="text-subtle"> · loops back</span> : null}
              </td>
              <td className="py-0.5 text-right tabular-nums">{n.count}</td>
              <td className="py-0.5 text-right tabular-nums text-muted">
                {formatDuration(n.medianSeconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
