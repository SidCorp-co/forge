import { cn } from '@/lib/utils/cn';
import type { ButtonHTMLAttributes } from 'react';

const variants = {
  primary: 'text-on-primary disabled:opacity-50',
  secondary: 'bg-outline-variant text-primary hover:bg-surface-variant',
  ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low',
  danger: 'bg-error-container text-on-error-container hover:bg-error-container/80 disabled:opacity-50',
};

const sizes = {
  xs: 'px-3 py-2 text-xs',
  sm: 'px-3 py-2.5 text-sm',
  md: 'px-4 py-2.5 text-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export function Button({ variant = 'primary', size = 'md', className, style, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-all duration-150 active:scale-[0.98]',
        variants[variant],
        sizes[size],
        className,
      )}
      style={variant === 'primary' ? { background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-tertiary) 100%)', ...style } : style}
      {...props}
    />
  );
}
