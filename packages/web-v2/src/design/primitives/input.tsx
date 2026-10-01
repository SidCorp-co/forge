import type { InputHTMLAttributes, Ref } from "react";
import { Input as ShadcnInput } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  variant?: "default" | "bare";
  ref?: Ref<HTMLInputElement>;
}

const FIELD =
  "h-auto rounded-md border-line-strong bg-surface px-3 py-2 text-base text-fg md:text-sm placeholder:text-disabled transition-shadow focus-visible:border-[color:var(--link)] focus-visible:ring-0 focus-visible:shadow-[var(--shadow-focus)] aria-[invalid=true]:border-[color:var(--red-500)] aria-[invalid=true]:ring-0";

const BARE =
  "h-auto rounded-none border-0 bg-transparent p-0 text-base text-fg md:text-15 placeholder:text-disabled focus-visible:ring-0 focus-visible:shadow-none";

export function Input({ icon, variant = "default", className, ...props }: InputProps) {
  const bare = variant === "bare";
  return (
    <div className={cn("relative flex items-center", className)}>
      {icon && (
        <Icon
          name={icon}
          size={16}
          className={cn("pointer-events-none absolute text-subtle", bare ? "left-0" : "left-3")}
        />
      )}
      <ShadcnInput className={cn(bare ? BARE : FIELD, icon && (bare ? "pl-7" : "pl-9"))} {...props} />
    </div>
  );
}
