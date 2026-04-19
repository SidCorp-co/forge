import { cn } from '@/lib/utils/cn';
import { forwardRef, type InputHTMLAttributes } from 'react';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, className, id, ...props }, ref) => (
    <label htmlFor={id} className="flex items-center gap-2">
      <input
        ref={ref}
        type="checkbox"
        id={id}
        className={cn('h-4 w-4 rounded-sm border-outline-variant bg-surface text-primary focus:ring-0 focus:ring-offset-0', className)}
        {...props}
      />
      {label && <span className="text-sm font-medium text-on-surface-variant">{label}</span>}
    </label>
  ),
);
Checkbox.displayName = 'Checkbox';
