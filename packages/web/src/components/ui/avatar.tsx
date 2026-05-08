import { cn } from '@/lib/utils/cn';

export type AvatarSize = 'xs' | 'sm' | 'md';

interface AvatarProps {
  email: string | null;
  userId?: string | null;
  size?: AvatarSize;
  title?: string;
  className?: string;
}

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
};

const PALETTE = [
  'bg-blue-500/20 text-blue-300',
  'bg-emerald-500/20 text-emerald-300',
  'bg-amber-500/20 text-amber-300',
  'bg-rose-500/20 text-rose-300',
  'bg-violet-500/20 text-violet-300',
  'bg-cyan-500/20 text-cyan-300',
  'bg-fuchsia-500/20 text-fuchsia-300',
  'bg-lime-500/20 text-lime-300',
];

function hashToIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulo;
}

function deriveInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const letters = local.replace(/[^a-zA-Z]/g, '').toUpperCase();
  if (letters.length === 0) return '?';
  if (letters.length === 1) return letters;
  return letters.slice(0, 2);
}

export function Avatar({ email, userId, size = 'sm', title, className }: AvatarProps) {
  const sizeClass = SIZE_CLASS[size];
  const label = title ?? email ?? 'Unassigned';

  if (email == null) {
    return (
      <span
        aria-label={label}
        title={label}
        className={cn(
          'inline-flex items-center justify-center rounded-full border border-dashed border-outline-variant/60 text-outline',
          sizeClass,
          className,
        )}
      >
        ?
      </span>
    );
  }

  const seed = userId ?? email;
  const palette = PALETTE[hashToIndex(seed, PALETTE.length)];

  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-full font-bold tracking-wider',
        palette,
        sizeClass,
        className,
      )}
    >
      {deriveInitials(email)}
    </span>
  );
}
