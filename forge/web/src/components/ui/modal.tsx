import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ open, onClose, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-on-primary/60 backdrop-blur-sm p-3 pt-[3vh] sm:p-4 sm:pt-[10vh]" onClick={onClose}>
      <div
        className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-sm border border-outline-variant/30 bg-surface-container-low shadow-[0_10px_30px_rgba(13,14,15,0.5)] sm:max-h-[80dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
