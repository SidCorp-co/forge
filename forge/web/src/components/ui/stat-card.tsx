interface StatCardProps {
  label: string;
  value: number | string;
  accent?: string;
  sub?: string;
}

export function StatCard({ label, value, accent, sub }: StatCardProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-sm border border-outline-variant/20 bg-surface-container-low px-3 py-3 sm:px-4 overflow-hidden">
      <span className="truncate text-[10px] font-medium uppercase tracking-widest text-primary-fixed">{label}</span>
      <span className={`truncate text-xl font-bold tabular-nums sm:text-2xl ${accent ?? 'text-primary'}`}>{value}</span>
      {sub && <span className="truncate text-[10px] text-outline">{sub}</span>}
    </div>
  );
}
