
import { Link } from "@/lib/navigation/router";
import { ForgeMascot } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** The 404's name and its way home, in the interface language of the scope it is drawn in. */
export function NotFoundBody() {
  const t = useCopy();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-app px-6 py-12 text-center">
      <ForgeMascot size={120} mode="blink" ring={false} progress={0.4} />
      {/* a name and the way home: why it is gone is no decision the person makes here (ISS-1131) */}
      <p className="fg-h2">{t("shell.notFound.title")}</p>
      <Link
        href="/"
        className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-13-5 font-semibold text-on-accent transition-colors hover:bg-accent-hover"
      >
        {t("shell.notFound.home")}
      </Link>
    </div>
  );
}
