import Link from "next/link";
import { Icon } from "@/design";
import { type AboutKind, chatAbout } from "../ask-about";

export function AskAboutThis({ slug, kind, refId }: { slug: string; kind: AboutKind; refId: string }) {
  return (
    <Link
      href={chatAbout(slug, kind, refId)}
      className="inline-flex items-center justify-center gap-[6px] whitespace-nowrap rounded-md border border-line-strong bg-surface px-[11px] py-[6px] text-13 font-semibold leading-none text-fg transition-colors duration-[120ms] hover:bg-hover focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
    >
      <Icon name="chat" size={15} />
      Ask about this
    </Link>
  );
}
