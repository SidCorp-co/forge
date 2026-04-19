interface SectionLabelProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <h2 className={`mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400 ${className ?? ""}`}>
      {children}
    </h2>
  );
}
