import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-8 text-center">
      {icon && <div className="mb-2 flex justify-center text-primary-fixed">{icon}</div>}
      <p className="text-sm text-outline">{title}</p>
      {description && <p className="mt-1 text-xs text-primary-fixed">{description}</p>}
    </div>
  );
}
