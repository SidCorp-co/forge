import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils/cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border font-semibold leading-none whitespace-nowrap transition-colors duration-[120ms] ease-[cubic-bezier(0.22,1,0.36,1)] select-none focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-accent-hover active:bg-accent-press focus-visible:shadow-[var(--shadow-focus-accent)]",
        outline: "border-line-strong bg-surface text-fg hover:bg-hover aria-expanded:bg-hover",
        secondary: "border-line-strong bg-surface text-fg hover:bg-hover aria-expanded:bg-hover",
        ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg",
        destructive:
          "border-[color:var(--red-500)] bg-surface text-[color:var(--red-600)] hover:bg-[var(--red-50)]",
        link: "border-transparent text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "gap-[7px] px-[15px] py-[9px] text-sm",
        xs: "gap-1 px-2 py-1 text-12",
        sm: "gap-[6px] px-[11px] py-[6px] text-13",
        lg: "gap-2 px-5 py-3 text-15",
        icon: "size-9",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button }
