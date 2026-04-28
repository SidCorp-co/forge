'use client';

import { forwardRef } from 'react';

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, id, className, ...rest },
  ref,
) {
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="group">
      <label
        htmlFor={id}
        className="block font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant group-focus-within:text-on-surface transition-colors"
      >
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={!!error}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        className={`mt-2 w-full bg-transparent border-0 border-b border-outline/40 rounded-none py-2.5 text-[15px] text-on-surface placeholder:text-outline/40 caret-warning focus:outline-none focus:border-b-warning focus:ring-0 transition-colors ${className ?? ''}`}
        {...rest}
      />
      {hint && !error && (
        <p
          id={hintId}
          className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-on-surface-variant/70"
        >
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-error">
          {error}
        </p>
      )}
    </div>
  );
});
