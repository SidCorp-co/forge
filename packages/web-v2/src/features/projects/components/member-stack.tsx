// A row of avatars from email-derived initials, each drawn whole beside the next (ISS-1072: an
// overlapping stack cut each one's initials), with a `+N` chip when the true `memberCount` exceeds them.
import { Avatar, type AvatarHue, keyedByContent } from '@/design';

const HUES: AvatarHue[] = ['cobalt', 'flame', 'green'];

interface MemberStackProps {
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
    <div className="flex items-center gap-0.5">
      {keyedByContent(members, (m) => m).map(({ key, item: m, index: i }) => (
        <span key={key} className="flex rounded-pill" data-testid="member-avatar">
          <Avatar initials={m} hue={HUES[i % HUES.length]} size={size} />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="inline-flex flex-none items-center justify-center rounded-pill bg-sunken font-mono font-semibold text-subtle"
          style={{ width: size, height: size, fontSize: size * 0.36 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
