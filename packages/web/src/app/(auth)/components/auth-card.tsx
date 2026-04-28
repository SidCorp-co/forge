import type { ReactNode } from 'react';

interface AuthCardProps {
  /** Mono uppercase tag above the heading, e.g. "Authenticate". */
  eyebrow: string;
  /** The h1 — sentence case, no period. */
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  children: ReactNode;
}

export function AuthCard({ eyebrow, title, description, children }: AuthCardProps) {
  return (
    <div className="w-full max-w-[440px]">
      <header className="mb-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-warning">
          <span aria-hidden className="mr-2 inline-block h-1.5 w-1.5 -translate-y-px bg-warning align-middle" />
          {eyebrow}
        </p>
        <h1 className="mt-4 text-[28px] leading-[1.1] tracking-tight text-on-surface">{title}</h1>
        {description && (
          <p className="mt-3 text-[14px] leading-relaxed text-on-surface-variant">{description}</p>
        )}
      </header>
      <div className="border border-outline-variant/60 bg-surface-container-lowest px-8 py-9 sm:px-10">
        {children}
      </div>
    </div>
  );
}
