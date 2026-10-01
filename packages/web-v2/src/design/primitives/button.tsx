import type { ButtonHTMLAttributes, Ref } from "react";
import { Button as ShadcnButton } from "@/components/ui/button";
import { Icon, type IconName } from "@/design/icons/icon";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
} as const;

const SIZE = { sm: "sm", md: "default" } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  disabled,
  type = "submit",
  children,
  ...props
}: ButtonProps) {
  const px = size === "sm" ? 15 : 16;
  return (
    <ShadcnButton
      type={type}
      variant={VARIANT[variant]}
      size={SIZE[size]}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Spinner size={px} className="border-current/40 border-t-current" />
      ) : (
        icon && <Icon name={icon} size={px} />
      )}
      {children}
    </ShadcnButton>
  );
}
