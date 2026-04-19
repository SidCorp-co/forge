interface PanelHeaderProps {
  left: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

export function PanelHeader({ left, right, className = "px-6" }: PanelHeaderProps) {
  return (
    <div className={`flex items-center justify-between border-b border-gray-200 py-3 ${className}`}>
      {left}
      {right}
    </div>
  );
}
