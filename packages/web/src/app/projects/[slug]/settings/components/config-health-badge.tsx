'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { ConfigHealthResult } from '../hooks/use-config-health';

interface Props {
  health: ConfigHealthResult;
}

export function ConfigHealthBadge({ health }: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const count = health.issues.length;
  const ok = health.status === 'ok';
  const first = health.issues[0];

  const onClick = () => {
    if (!first) return;
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set('section', first.section);
    next.set('focus', first.field);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  const tooltip = ok
    ? 'All sections look healthy.'
    : health.issues.map((i) => `• ${i.message}`).join('\n');

  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      disabled={ok}
      aria-label={ok ? 'Configuration healthy' : `${count} configuration issues`}
      className={`inline-flex items-center gap-2 rounded-sm border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors disabled:cursor-default ${
        ok
          ? 'border-success/30 bg-success-surface text-success'
          : 'border-warning/40 bg-warning-dim/10 text-warning hover:bg-warning-dim/20'
      }`}
    >
      <span aria-hidden>{ok ? '✓' : '⚠'}</span>
      <span>{ok ? 'OK' : `${count} ${count === 1 ? 'issue' : 'issues'}`}</span>
    </button>
  );
}
