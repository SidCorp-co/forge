import { useState, useCallback, useRef, useEffect } from 'react';

export function useToast() {
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
    };
  }, []);

  const addToast = useCallback((text: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, text }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(timer);
    }, 3000);
    timersRef.current.add(timer);
  }, []);

  return { toasts, addToast };
}
