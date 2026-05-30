"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Toast, type ToastView } from "@/design/primitives/toast";

interface ToastItem extends ToastView {
  id: number;
}

interface ToastApi {
  toast: (t: ToastView & { duration?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback<ToastApi["toast"]>(
    ({ duration = 4000, ...view }) => {
      const id = ++idRef.current;
      setItems((xs) => [...xs, { id, ...view }]);
      if (duration > 0) setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2.5">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <Toast {...t} onClose={() => remove(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
