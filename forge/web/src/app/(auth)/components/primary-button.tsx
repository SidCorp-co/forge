'use client';

import type { ButtonHTMLAttributes } from 'react';

interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loadingLabel?: string;
}

export function PrimaryButton({
  loading,
  loadingLabel = 'WORKING…',
  children,
  disabled,
  className,
  ...rest
}: PrimaryButtonProps) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className={`group relative w-full overflow-hidden bg-on-surface text-surface-container-lowest py-3.5 font-mono text-[11px] uppercase tracking-[0.22em] transition-all duration-200 hover:-translate-y-px hover:shadow-[0_8px_24px_-12px_rgba(133,83,0,0.45)] active:translate-y-0 disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-lowest ${className ?? ''}`}
      {...rest}
    >
      <span className="relative inline-flex items-center justify-center gap-3">
        {loading ? loadingLabel : children}
        {!loading && (
          <span aria-hidden className="text-warning transition-transform duration-200 group-hover:translate-x-0.5">
            →
          </span>
        )}
      </span>
    </button>
  );
}
