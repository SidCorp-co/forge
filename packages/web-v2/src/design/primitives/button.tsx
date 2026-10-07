"use client";

import { type ButtonHTMLAttributes, createContext, type ReactNode, type Ref, useContext } from "react";
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

const SecondaryOnly = createContext(false);

// a region beside the page (the Ask Agent dock) never carries a primary action: the page's one
// primary keeps that colour, so a primary asked for inside the region is drawn as a secondary (REQ-11 BC-8)
export function SecondaryRegion({ children }: { children: ReactNode }) {
  return <SecondaryOnly.Provider value={true}>{children}</SecondaryOnly.Provider>;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  disabled,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  const px = size === "sm" ? 15 : 16;
  const secondaryOnly = useContext(SecondaryOnly);
  const shown = variant === "primary" && secondaryOnly ? "secondary" : variant;
  return (
    <ShadcnButton
      type={type}
      variant={VARIANT[shown]}
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
