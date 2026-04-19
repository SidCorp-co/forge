import { cn } from '@/lib/utils/cn';

const sizeMap = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2.5 w-2.5',
};

const colorMap = {
  blue: { ping: 'bg-info', dot: 'bg-info' },
  yellow: { ping: 'bg-warning', dot: 'bg-warning-dim/100' },
};

interface AgentRunningDotProps {
  size?: keyof typeof sizeMap;
  color?: keyof typeof colorMap;
}

export function AgentRunningDot({ size = 'md', color = 'blue' }: AgentRunningDotProps) {
  const s = sizeMap[size];
  const c = colorMap[color];
  return (
    <span className={cn('relative inline-block', s)}>
      <span className={cn('absolute inset-0 animate-ping rounded-full opacity-75', c.ping)} />
      <span className={cn('relative inline-block rounded-full', s, c.dot)} />
    </span>
  );
}
