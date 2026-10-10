"use client";

import { createContext, use } from "react";
import { Toaster, showToast, type ToastInput } from "@/design/primitives/toast";

interface ToastApi {
  toast: (t: ToastInput) => void;
}

// The context's default is the one toaster, so a tree mounted without the provider still toasts.
const ToastContext = createContext<ToastApi>({ toast: showToast });

export function useToast(): ToastApi {
  return use(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
