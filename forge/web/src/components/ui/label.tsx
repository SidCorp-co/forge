import { cn } from '@/lib/utils/cn';
import type { LabelHTMLAttributes, ReactNode } from 'react';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  hint?: ReactNode;
}

export function Label({ hint, className, children, ...props }: LabelProps) {
  return (
    <label className={cn('mb-1 block text-[10px] font-medium uppercase tracking-widest text-on-surface-variant', className)} {...props}>
      {children}
      {hint && <span className="ml-1 text-[9px] font-normal tracking-widest text-primary-fixed">{hint}</span>}
    </label>
  );
}
