interface Toast {
  id: string;
  text: string;
}

export function ToastContainer({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="animate-slide-in rounded-lg bg-surface px-4 py-2.5 text-sm text-on-surface shadow-lg"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
