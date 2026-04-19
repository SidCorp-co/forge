interface PageShellProps {
  title: string;
  subtitle?: string;
  maxWidth?: string;
  scrollable?: boolean;
  children: React.ReactNode;
}

export function PageShell({ title, subtitle, maxWidth = "max-w-2xl", scrollable, children }: PageShellProps) {
  const inner = (
    <div className={`mx-auto ${scrollable ? "p-6" : "p-8"} ${maxWidth}`}>
      <h1 className="mb-1 text-lg font-bold text-gray-900">{title}</h1>
      {subtitle && <p className="mb-6 text-xs text-gray-500">{subtitle}</p>}
      {children}
    </div>
  );

  if (scrollable) {
    return <div className="h-full overflow-y-auto bg-gray-50">{inner}</div>;
  }

  return inner;
}
