import { cn } from '@/lib/utils/cn';

const VARIANTS = {
  warning: 'border-outline-variant bg-surface-container-high text-secondary-dim',
  error: 'border-error-container bg-error-container/10 text-error',
};

export function AlertBanner({ variant, children }: { variant: 'warning' | 'error'; children: React.ReactNode }) {
  return (
    <div className={cn('mb-4 rounded-sm border p-3 text-sm', VARIANTS[variant])}>
      {children}
    </div>
  );
}
