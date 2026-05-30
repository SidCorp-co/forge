'use client';

import { useMemo } from 'react';

/**
 * Lightweight realtime strength hint — a heuristic over length + character-class
 * variety, no dependency. It is purely advisory: core enforces a real zxcvbn
 * score gate server-side (`packages/core/src/auth/register.ts`), so a weak choice
 * is rejected on submit regardless of what this bar shows. We deliberately skip
 * the ~120KB zxcvbn dictionary bundle to keep the cold /register payload small.
 *
 * The five-segment bar + colour ramp (red → amber → green) reuses v2 tokens.
 */

const LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

// Indexed by score (0..4) — red for the weak end, amber mid, green strong.
const RAMP = [
  'var(--red-500)',
  'var(--red-500)',
  'var(--amber-500)',
  'var(--green-500)',
  'var(--green-500)',
] as const;

function scorePassword(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^A-Za-z0-9]/.test(pw)) variety++;

  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (variety >= 2) score++;
  if (variety >= 3 && pw.length >= 10) score++;
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
}

export function PasswordMeter({ password }: { password: string }) {
  const score = useMemo(() => scorePassword(password), [password]);
  if (!password) return null;

  const filled = score + 1;
  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-pill transition-colors duration-200"
            style={{ background: i < filled ? RAMP[score] : 'var(--border-strong)' }}
          />
        ))}
      </div>
      <span className="fg-caption mt-1.5 block" style={{ color: RAMP[score] }}>
        {LABELS[score]}
      </span>
    </div>
  );
}
