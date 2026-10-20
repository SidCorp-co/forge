// Overlapping avatar stack from the members' name initials, with a `+N` overflow
// chip when the true `memberCount` exceeds the rendered avatars.
import { Avatar, type AvatarHue } from '@/design';

const HUES: AvatarHue[] = ['cobalt', 'flame', 'green'];

export interface MemberStackProps {
  /** Up to 5 avatar initials from the health rollup. */
  members: string[];
  /** True total membership count (drives the `+N` overflow). */
  total: number;
  size?: number;
}

export function MemberStack({ members, total, size = 24 }: MemberStackProps) {
  if (members.length === 0) return null;
  const overflow = Math.max(0, total - members.length);
  return (
    <div className="flex flex-none items-center">
      {members.map((m, i) => (
        <span
          key={`${m}-${i}`}
          className="rounded-pill ring-2 ring-[color:var(--bg-surface)]"
          style={{ marginLeft: i ? -4 : 0 }}
        >
          <Avatar initials={m} hue={HUES[i % HUES.length]} size={size} />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="ml-[-4px] inline-flex flex-none items-center justify-center rounded-pill bg-sunken font-mono font-semibold text-subtle ring-2 ring-[color:var(--bg-surface)]"
          style={{ width: size, height: size, fontSize: size * 0.36 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
