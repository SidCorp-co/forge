import { Button } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** The rows a home section holds past its first ones, opened on demand. */
export function ShowMore({ hidden, onShow }: { hidden: number; onShow: () => void }) {
  const t = useCopy();
  if (hidden <= 0) return null;
  return (
    <Button variant="ghost" size="sm" onClick={onShow} className="self-start">
      {t("overview.home.more", { n: hidden })}
    </Button>
  );
}
