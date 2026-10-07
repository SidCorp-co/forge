import type { ButtonHTMLAttributes, Ref } from "react";
import { Button as ShadcnButton } from "@/components/ui/button";
import { Icon, type IconName } from "@/design/icons/icon";

type Variant = "ghost" | "secondary";
type Size = "sm" | "md";

const VARIANT = { ghost: "ghost", secondary: "outline" } as const;
const SIZES: Record<Size, { size: "icon-sm" | "icon"; icon: number }> = {
  sm: { size: "icon-sm", icon: 16 },
  md: { size: "icon", icon: 18 },
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  variant?: Variant;
  size?: Size;
  "aria-label": string;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ icon, variant = "ghost", size = "md", type = "button", ...props }: IconButtonProps) {
  const s = SIZES[size];
  return (
    <ShadcnButton type={type} variant={VARIANT[variant]} size={s.size} {...props}>
      <Icon name={icon} size={s.icon} />
    </ShadcnButton>
  );
}
