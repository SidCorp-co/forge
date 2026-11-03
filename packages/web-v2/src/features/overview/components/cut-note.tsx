import { useCopy } from "@/lib/i18n/interface-language";

/** "50 of 132": a list core cut says how many it holds of how many, so it never reads as complete. */
export function CutNote({ shown, total }: { shown: number; total: number }) {
  const t = useCopy();
  if (total <= shown) return null;
  return (
    <p className="text-12 text-muted" data-testid="home-cut">
      {t("overview.home.cut", { shown, total })}
    </p>
  );
}
