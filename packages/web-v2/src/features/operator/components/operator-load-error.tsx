
import { useRouter } from "@/lib/navigation/router";
import { ErrorState } from "@/design";

export function OperatorLoadError({ title, message }: { title?: string; message: string }) {
  const router = useRouter();
  return (
    <div className="flex h-dvh items-center justify-center bg-app">
      <ErrorState title={title} message={message} onRetry={() => router.refresh()} />
    </div>
  );
}
