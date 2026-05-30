import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

type Variant = "ghost" | "secondary";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  ghost: "text-muted hover:bg-hover hover:text-fg border-transparent",
  secondary: "bg-surface text-fg border-line-strong hover:bg-hover",
};
const SIZES: Record<Size, { box: string; icon: number }> = {
  sm: { box: "size-7", icon: 16 },
  md: { box: "size-9", icon: 18 },
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  variant?: Variant;
  size?: Size;
  "aria-label": string;
}

export function IconButton({ icon, variant = "ghost", size = "md", className, ...props }: IconButtonProps) {
  const s = SIZES[size];
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md border transition-colors duration-[120ms]",
        "disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none",
        s.box,
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      <Icon name={icon} size={s.icon} />
    </button>
  );
}
