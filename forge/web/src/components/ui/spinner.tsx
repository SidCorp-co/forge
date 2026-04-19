import { cn } from '@/lib/utils/cn';

const SIZES = {
  sm: 'h-5 w-5 border-2',
  md: 'h-8 w-8 border-2',
};

export function Spinner({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  return (
    <div className={cn('border-outline-variant border-t-white rounded-full animate-spin', SIZES[size], className)} />
  );
}
