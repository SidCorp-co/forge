import { useCopy } from "@/lib/i18n/interface-language";
import { Button } from "./button";
import { ForgeMascot } from "@/design/patterns/forge-mascot";

export interface ErrorStateProps {
  title?: string;
  /** Plain cause + remedy — never apologetic. */
  message: string;
  onRetry?: () => void;
  /** Lead with the mascot (default). Set false for dense inline spots. */
  mascot?: boolean;
}

/** Failure state — mascot (flame stilled) + one line + a retry. Never a dead end. */
export function ErrorState({ title, message, onRetry, mascot = true }: ErrorStateProps) {
  const t = useCopy();
  return (
    <div className="flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center">
      {mascot && <ForgeMascot size={88} mode="blink" ring={false} flicker={false} progress={0.4} />}
      <div>
        <p className="fg-h3">{title ?? t("common.couldNotLoad")}</p>
        <p className="fg-body-sm mx-auto mt-1 max-w-[260px]">{message}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" icon="rerun" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
