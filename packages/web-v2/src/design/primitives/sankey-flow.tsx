import { cn } from "@/lib/utils/cn";

export interface SankeyNode {
  key: string;
  label: string;
  count: number;
  /** Median seconds one of these took, or null where none finished. */
  medianSeconds: number | null;
}

export interface SankeyFlowProps {
  nodes: SankeyNode[];
  /** Sentence a reader who cannot see the drawing gets instead. */
  label: string;
  formatDuration: (seconds: number | null) => string;
  className?: string;
}

/**
 * How much of each kind of work ran, side by side, and how long the middle one took. The kinds are
 * independent, so nothing joins one bar to the next: a line between them would read as one kind
 * feeding the next, a sequence of stages the pipeline does not have.
 */
export function SankeyFlow({ nodes, label, formatDuration, className }: SankeyFlowProps) {
  if (nodes.length === 0) return null;

  const max = Math.max(1, ...nodes.map((n) => n.count));

  const width = 640;
  const height = 96;
  const slot = width / nodes.length;
  const barW = Math.max(4, slot * 0.5);
  const mid = 34;

  return (
    <figure className={cn("m-0 flex w-full flex-col gap-3", className)}>
      <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block h-24 w-full"
        >
          <title>{label}</title>
          {nodes.map((n, i) => {
            const h = Math.max(3, (n.count / max) * 44);
            const x = i * slot + (slot - barW) / 2;
            return (
              <g key={n.key}>
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
        </svg>
      <table className="w-full">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="fg-body-sm text-subtle">
            <th scope="col" className="text-left font-normal">Work</th>
            <th scope="col" className="text-right font-normal">Jobs</th>
            <th scope="col" className="text-right font-normal">Median</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.key} className="fg-body-sm">
              <td className="py-0.5 text-left">
                {n.label}
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
