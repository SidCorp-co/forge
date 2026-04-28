'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Realtime zxcvbn meter — client-side only, code-split so the ~50KB
 * dictionary bundle never ships outside the register page.
 *
 * The bar mirrors zxcvbn's 0..4 score with five segments + a colour ramp
 * (red → amber → emerald). Server-side enforcement is independent (see
 * packages/core/src/auth/password-strength.ts) so a tampered client cannot
 * smuggle a weak password through.
 */

interface MeterResult {
  score: 0 | 1 | 2 | 3 | 4;
  warning: string;
  suggestions: string[];
}

const LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

const SEGMENT_BG = [
  'bg-error',
  'bg-warning-dim',
  'bg-warning',
  'bg-success',
  'bg-success',
] as const;

const LABEL_COLOR = [
  'text-error',
  'text-warning-dim',
  'text-warning',
  'text-success',
  'text-success',
] as const;

interface PasswordMeterProps {
  password: string;
  /** Personal context fed to zxcvbn (typically the user's email). */
  userInputs?: string[];
}

export function PasswordMeter({ password, userInputs = [] }: PasswordMeterProps) {
  const [result, setResult] = useState<MeterResult | null>(null);

  // The dictionary packages are heavy (~120KB unminified). Loading them on
  // demand the first time the user types into the password field keeps
  // the initial /register payload small.
  useEffect(() => {
    if (!password) {
      setResult(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const [{ zxcvbn, zxcvbnOptions }, common, en] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
      ]);
      zxcvbnOptions.setOptions({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...en.dictionary },
      });
      const r = zxcvbn(password, userInputs);
      if (cancelled) return;
      setResult({
        score: r.score,
        warning: r.feedback.warning ?? '',
        suggestions: r.feedback.suggestions ?? [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [password, userInputs.join('|')]);

  const filled = useMemo(() => (result ? result.score + 1 : 0), [result]);

  if (!password) return null;

  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 transition-colors duration-200 ${
              i < filled && result ? SEGMENT_BG[result.score] : 'bg-outline-variant/40'
            }`}
          />
        ))}
      </div>
      {result && (
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.18em] ${LABEL_COLOR[result.score]}`}
          >
            {LABELS[result.score]}
          </span>
          {result.warning && (
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-on-surface-variant truncate">
              {result.warning}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
