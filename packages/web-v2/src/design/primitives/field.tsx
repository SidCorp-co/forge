
import { createContext, type ReactNode, use, useId } from "react";

export interface FieldProps {
  label: string;
  /** Explicit id; otherwise auto-generated and wired to the control. */
  htmlFor?: string;
  /** Helper text; a node when part of it is an identifier the reader types as written. */
  hint?: ReactNode;
  /** When set, the field renders in an error state (red helper + aria). */
  error?: string;
  required?: boolean;
  children: ReactNode;
}

/** What a Field gives the control inside it: the id its label points at, and its descriptions. */
export type FieldControl = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

const FieldControlContext = createContext<FieldControl | null>(null);

/** The enclosing Field's id and descriptions, for a design control to spread under its own props. */
export function useFieldControl(): Partial<FieldControl> {
  return use(FieldControlContext) ?? {};
}

/** Form field wrapper — owns the label↔control association, required marker,
    and helper/error text. The design controls inside it (Input, Textarea, Select, NativeSelect,
    ChipPicker) take its `id`, `aria-describedby` and `aria-invalid` from context. */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const descId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  const control: FieldControl = { id, "aria-describedby": descId, "aria-invalid": error ? true : undefined };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="fg-label">
        {label}
        {required ? <span className="text-danger-9" aria-hidden> *</span> : null}
      </label>
      <FieldControlContext value={control}>{children}</FieldControlContext>
      {error ? (
        <p id={descId} role="alert" className="fg-caption text-danger-11">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="fg-caption">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
