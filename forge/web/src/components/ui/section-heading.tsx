import { cn } from '@/lib/utils/cn';

export function SectionHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={cn('mb-3 text-[10px] font-semibold uppercase tracking-widest text-primary-fixed', className)}>
      {children}
    </h2>
  );
}
