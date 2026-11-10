/** A share drawn as a ring: the track, and the arc of `share` in the first series colour. */
export function Ring({ share, size = 44 }: { share: number; size?: number }) {
  const r = 15;
  const arc = 2 * Math.PI * r;
  return (
    <svg aria-hidden viewBox="0 0 36 36" width={size} height={size} className="flex-none" data-testid="home-ring">
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--bg-active)" strokeWidth="4.5" />
      {share > 0 ? (
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--chart-2)" strokeWidth="4.5" strokeLinecap="round" strokeDasharray={`${arc * Math.min(share, 1)} ${arc}`} transform="rotate(-90 18 18)" />
      ) : null}
    </svg>
  );
}
