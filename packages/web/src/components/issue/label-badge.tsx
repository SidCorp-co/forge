'use client';

interface LabelBadgeProps {
  name: string;
  color: string;
  size?: 'sm' | 'md';
  onRemove?: () => void;
}

function getContrastColor(hex: string): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#1f2328' : '#ffffff';
}

export function LabelBadge({ name, color, size = 'sm', onRemove }: LabelBadgeProps) {
  const textColor = getContrastColor(color);
  const sizeClasses = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-0.5 text-sm';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium leading-tight ${sizeClasses}`}
      style={{ backgroundColor: color, color: textColor }}
    >
      {name}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 rounded-full hover:opacity-70"
          style={{ color: textColor }}
        >
          &times;
        </button>
      )}
    </span>
  );
}
