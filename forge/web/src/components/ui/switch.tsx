import { cn } from '@/lib/utils/cn';
import { forwardRef, type InputHTMLAttributes } from 'react';

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ label, className, id, ...props }, ref) => (
    <label htmlFor={id} className={cn('flex items-center gap-3 cursor-pointer', className)}>
      <span className="relative inline-flex items-center">
        <input
          ref={ref}
          type="checkbox"
          id={id}
          className="peer sr-only"
          {...props}
        />
        <span className="block h-5 w-9 rounded-none bg-surface-container-highest border border-outline-variant/30 peer-checked:bg-primary-fixed peer-focus-visible:ring-1 peer-focus-visible:ring-primary transition-colors" />
        <span className="absolute left-[3px] top-[3px] h-3.5 w-3.5 bg-outline peer-checked:bg-primary peer-checked:translate-x-[14px] transition-all" />
      </span>
      {label && <span className="text-sm text-on-surface-variant">{label}</span>}
    </label>
  ),
);
Switch.displayName = 'Switch';
