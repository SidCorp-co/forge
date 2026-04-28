import clsx from "clsx";

const variants = {
  warning: "border-yellow-200 bg-yellow-50 text-yellow-800",
  error: "border-red-200 bg-red-50 text-red-700",
};

interface AlertBannerProps {
  variant: "warning" | "error";
  children: React.ReactNode;
}

export function AlertBanner({ variant, children }: AlertBannerProps) {
  return (
    <div className={clsx("rounded-lg border px-4 py-3 text-sm", variants[variant])}>
      {children}
    </div>
  );
}
