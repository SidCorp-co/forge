export function UsageMetric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white px-4 py-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${accent ? "text-orange-600" : "text-gray-900"}`}>{value}</span>
      {sub && <span className="text-[11px] text-gray-400">{sub}</span>}
    </div>
  );
}
