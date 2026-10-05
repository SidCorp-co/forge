"use client";

import { Toaster, showToast, type ToastInput } from "@/design/primitives/toast";

interface ToastApi {
  toast: (t: ToastInput) => void;
}

const api: ToastApi = { toast: showToast };

export function useToast(): ToastApi {
  return api;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
