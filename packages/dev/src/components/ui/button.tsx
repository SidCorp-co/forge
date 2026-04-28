import clsx from "clsx";

const variants = {
  primary: "bg-gray-900 text-white hover:bg-gray-700",
  secondary: "border border-gray-200 text-gray-700 hover:bg-gray-50",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

const sizes = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-4 py-2 text-sm",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export function Button({ variant = "primary", size = "md", className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx("rounded-lg font-medium disabled:opacity-50", variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
    </button>
  );
}
