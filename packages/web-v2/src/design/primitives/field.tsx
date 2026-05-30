import type { ReactNode } from "react";

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="fg-label">
        {label}
      </label>
      {children}
      {hint && <p className="fg-caption">{hint}</p>}
    </div>
  );
}
