import { cn } from '@/lib/utils/cn';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="flex rounded-sm bg-surface border border-outline-variant/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded-sm px-3 py-2.5 text-sm font-medium transition-colors',
            value === opt.value ? 'bg-surface-container-high text-primary' : 'text-outline hover:text-on-surface'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
