"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

export interface FieldProps {
  label: string;
  /** Explicit id; otherwise auto-generated and wired to the control. */
  htmlFor?: string;
  hint?: string;
  /** When set, the field renders in an error state (red helper + aria). */
  error?: string;
  required?: boolean;
  children: ReactNode;
}

/** Form field wrapper — owns the label↔control association, required marker,
    and helper/error text. It injects `id`, `aria-describedby`, and
    `aria-invalid` onto its child so every control is correctly described. */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const descId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        "aria-describedby": descId,
        "aria-invalid": error ? true : undefined,
      })
    : children;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="fg-label">
        {label}
        {required && <span style={{ color: "var(--red-500)" }} aria-hidden> *</span>}
      </label>
      {control}
      {error ? (
        <p id={descId} role="alert" className="fg-caption" style={{ color: "var(--red-600)" }}>
          {error}
        </p>
      ) : (
        hint && (
          <p id={descId} className="fg-caption">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
