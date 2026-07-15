import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  /** default = bordered field · bare = transparent, borderless (command
      palettes, inline editors) — no own ring/border, sits inside a framed row. */
  variant?: "default" | "bare";
}

export function Input({ icon, variant = "default", className, ...props }: InputProps) {
  if (variant === "bare") {
    return (
      <div className={cn("relative flex items-center", className)}>
        {icon && <Icon name={icon} size={16} className="pointer-events-none absolute left-0 text-subtle" />}
        <input
          className={cn(
            "w-full border-0 bg-transparent p-0 text-base text-fg md:text-[15px]",
            "placeholder:text-disabled focus-visible:shadow-none focus-visible:outline-none",
            icon && "pl-7",
          )}
          {...props}
        />
      </div>
    );
  }

  return (
    <div className={cn("relative flex items-center", className)}>
      {icon && (
        <Icon name={icon} size={16} className="pointer-events-none absolute left-3 text-subtle" />
      )}
      <input
        className={cn(
          "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-fg md:text-sm",
          "placeholder:text-disabled disabled:cursor-not-allowed disabled:opacity-50",
          icon && "pl-9",
          // own ring: cobalt + border tint; overrides the global focus ring
          "transition-shadow focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
          // error state (driven by Field via aria-invalid)
          "aria-[invalid=true]:border-[color:var(--red-500)] aria-[invalid=true]:focus-visible:border-[color:var(--red-500)]",
        )}
        {...props}
      />
    </div>
  );
}
