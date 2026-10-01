"use client";

import { toast as sonner } from "sonner";
import { Toaster as ShadcnToaster } from "@/components/ui/sonner";
import { Icon } from "@/design/icons/icon";

export type ToastTone = "default" | "success" | "error" | "info";

export interface ToastView {
  title: string;
  description?: string;
  tone?: ToastTone;
  onClick?: () => void;
}

export interface ToastInput extends ToastView {
  duration?: number;
  slot?: string;
}

export const MAX_VISIBLE_TOASTS = 3;

export function showToast({ title, description, tone = "default", onClick, duration = 4000, slot }: ToastInput) {
  const options = {
    id: slot,
    description,
    duration: duration > 0 ? duration : Number.POSITIVE_INFINITY,
    closeButton: true,
    action: onClick ? { label: "Open", onClick } : undefined,
  };
  if (tone === "success") sonner.success(title, options);
  else if (tone === "error") sonner.error(title, options);
  else if (tone === "info") sonner.info(title, options);
  else sonner(title, options);
}

export function Toaster() {
  return (
    <ShadcnToaster
      position="bottom-right"
      visibleToasts={MAX_VISIBLE_TOASTS}
      mobileOffset={{ bottom: "calc(64px + env(safe-area-inset-bottom))" }}
      icons={{
        success: <Icon name="check" size={17} style={{ color: "var(--green-500)" }} />,
        error: <Icon name="alert" size={17} style={{ color: "var(--red-500)" }} />,
        info: <Icon name="activity" size={17} style={{ color: "var(--cobalt-500)" }} />,
      }}
      toastOptions={{
        classNames: {
          toast: "!w-[320px] !rounded-lg !border-line !bg-surface !px-4 !py-3 !shadow-lg !font-sans",
          title: "fg-label",
          description: "fg-caption !text-subtle",
          actionButton: "!bg-accent !text-on-accent !font-semibold",
          closeButton: "!bg-surface !border-line !text-subtle hover:!text-fg",
        },
      }}
    />
  );
}
