import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
}

export function Input({ icon, className, ...props }: InputProps) {
  return (
    <div className={cn("relative flex items-center", className)}>
      {icon && (
        <Icon
          name={icon}
          size={16}
          className="pointer-events-none absolute left-3 text-subtle"
        />
      )}
      <input
        className={cn(
          "w-full rounded-md border border-line-strong bg-surface text-sm text-fg",
          "placeholder:text-disabled",
          "px-3 py-2",
          icon && "pl-9",
          "transition-shadow focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
        )}
        {...props}
      />
    </div>
  );
}
