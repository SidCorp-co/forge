import { Check, Minus } from 'lucide-react';

// Honest comparison. Marks reflect "ships in the box, today" — not roadmap.
// Sources: project README of each tool + observed default behavior. Update if
// any of them ship feature parity (and we welcome PRs).
type Cell = 'yes' | 'no' | 'partial';

const tools = ['Forge', 'Linear', 'Cursor', 'Devin'] as const;

interface Row {
  feature: string;
  marks: Record<(typeof tools)[number], Cell>;
  note?: string;
}

const rows: Row[] = [
  {
    feature: 'Open source · Apache-2.0',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'no', Devin: 'no' },
  },
  {
    feature: 'Self-host on your hardware',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'partial', Devin: 'no' },
  },
  {
    feature: 'Local-first AI runner (no proxy)',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'yes', Devin: 'no' },
  },
  {
    feature: 'Pluggable runner adapters',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'no', Devin: 'no' },
  },
  {
    feature: 'Issue tracking + kanban',
    marks: { Forge: 'yes', Linear: 'yes', Cursor: 'no', Devin: 'no' },
  },
  {
    feature: 'MCP-native end-to-end',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'partial', Devin: 'no' },
  },
  {
    feature: 'Pipeline self-healing (auto-retry, classifier)',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'no', Devin: 'partial' },
  },
  {
    feature: 'Brings your own Claude subscription',
    marks: { Forge: 'yes', Linear: 'no', Cursor: 'yes', Devin: 'no' },
  },
];

function CellMark({ value }: { value: Cell }) {
  if (value === 'yes') {
    return (
      <div
        className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-success/10"
        aria-label="Yes"
      >
        <Check className="w-4 h-4 text-success" aria-hidden />
      </div>
    );
  }
  if (value === 'partial') {
    return (
      <div
        className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-warning/10"
        aria-label="Partial"
      >
        <Minus className="w-4 h-4 text-warning" aria-hidden />
      </div>
    );
  }
  return (
    <div
      className="inline-flex w-7 h-7 items-center justify-center rounded-full bg-outline-variant/30"
      aria-label="No"
    >
      <span className="block w-3 h-px bg-outline" aria-hidden />
    </div>
  );
}

export function DownloadComparison() {
  return (
    <section
      id="comparison"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-24 border-t border-outline-variant/20"
    >
      <div className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.04)_0%,transparent_70%)]" />

      <div className="text-center mb-12">
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          How Forge compares
        </p>
        <h2 className="font-serif text-3xl sm:text-4xl md:text-5xl tracking-tight mb-3">
          Different goal,{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            different shape
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          Forge sits where issue trackers and AI coding agents overlap — and
          stays open-source. Honest table; PRs welcome if a row drifts.
        </p>
      </div>

      <div className="rounded-2xl border border-outline-variant/20 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/20 bg-surface-container-low/30">
                <th
                  scope="col"
                  className="px-5 py-4 text-left font-mono text-[11px] uppercase tracking-[0.1em] text-primary-fixed"
                >
                  Capability
                </th>
                {tools.map((tool) => (
                  <th
                    key={tool}
                    scope="col"
                    className={`px-3 py-4 text-center font-mono text-[11px] uppercase tracking-[0.1em] ${
                      tool === 'Forge'
                        ? 'text-warning font-semibold'
                        : 'text-primary-fixed'
                    }`}
                  >
                    {tool}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr
                  key={row.feature}
                  className={
                    idx % 2 === 0 ? 'bg-white' : 'bg-surface-container-low/20'
                  }
                >
                  <th
                    scope="row"
                    className="px-5 py-4 text-left text-on-surface font-light leading-tight"
                  >
                    {row.feature}
                  </th>
                  {tools.map((tool) => (
                    <td
                      key={tool}
                      className={`px-3 py-4 text-center ${
                        tool === 'Forge' ? 'bg-warning/[0.04]' : ''
                      }`}
                    >
                      <CellMark value={row.marks[tool]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-5 text-center text-xs text-primary-fixed/70 font-light">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-success/30 align-middle" />{' '}
          Yes
        </span>
        <span className="mx-3 text-outline-variant">·</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-warning/30 align-middle" />{' '}
          Partial
        </span>
        <span className="mx-3 text-outline-variant">·</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-outline-variant/40 align-middle" />{' '}
          No
        </span>
      </p>
    </section>
  );
}
