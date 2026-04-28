import { cn } from '@/lib/utils/cn';
import { forwardRef, type TextareaHTMLAttributes } from 'react';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-sm border border-outline-variant/30 bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-outline/40 resize-none focus:border-outline focus:outline-none transition-colors',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
