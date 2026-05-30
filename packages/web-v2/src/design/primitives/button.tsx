import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  // accent button → flame focus ring (overrides the global cobalt ring)
  primary: "bg-accent text-on-accent shadow-xs hover:bg-accent-hover active:bg-accent-press border-transparent focus-visible:shadow-[var(--shadow-focus-accent)] focus-visible:outline-none",
  secondary: "bg-surface text-fg border-line-strong hover:bg-hover",
  ghost: "bg-transparent text-muted border-transparent hover:bg-hover hover:text-fg",
  danger: "bg-surface text-[color:var(--red-600)] border-[color:var(--red-500)] hover:bg-[var(--red-50)]",
};

const SIZES: Record<Size, string> = {
  sm: "text-[13px] px-[11px] py-[6px] gap-[6px]",
  md: "text-sm px-[15px] py-[9px] gap-[7px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md border font-semibold leading-none",
        "transition-colors duration-[120ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 16} />}
      {children}
    </button>
  );
}
