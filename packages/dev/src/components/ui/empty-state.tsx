interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
      {icon && <div className="mb-2">{icon}</div>}
      <p className="text-sm text-gray-500">{title}</p>
      {description && <p className="mt-1 text-xs text-gray-400">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
