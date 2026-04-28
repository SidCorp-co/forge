'use client';

// Phase 2.6-F2: the @-mention user picker hit /users?filters on Strapi.
// Core has no equivalent user-search endpoint yet. The component falls back
// to a plain textarea until a search endpoint ships.

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  // biome-ignore lint/suspicious/noExplicitAny: legacy surface; all extra props are ignored
  [key: string]: any;
}

export function MentionInput({ value, onChange, placeholder, className, rows }: MentionInputProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows ?? 3}
      className={className}
    />
  );
}

export default MentionInput;
