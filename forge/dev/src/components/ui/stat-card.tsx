interface StatCardProps {
  label: string;
  value: number | string;
  accent?: string;
  sub?: string;
}

export function StatCard({ label, value, accent, sub }: StatCardProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
      <p className={`text-2xl font-bold ${accent ?? "text-gray-900"}`}>{value}</p>
      <p className="text-sm text-gray-500">{label}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}
