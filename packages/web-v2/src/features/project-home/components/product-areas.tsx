// The Product drawer's picture: criteria proven in each business area, one ring each, its share and
// how many requirements it holds; the counts behind the share open on hover.

import type { HomeArea } from "@forge/contracts/project-home";
import { Ring, shareOf, Tooltip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export function ProductAreas({ areas }: { areas: readonly HomeArea[] }) {
  const t = useCopy();
  if (areas.length === 0) return <p className="text-13 text-subtle">{t("home.none")}</p>;
  return (
    <figure className="m-0" data-testid="home-areas">
      <figcaption className="pb-2 text-12 text-subtle">{t("home.product.byArea")}</figcaption>
      <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
        {areas.map((a) => {
          const name = a.name ?? t("requirements.noArea");
          const share = shareOf(a.proven, a.total);
          return (
            <li key={name} className="bg-sunken px-3 py-2.5">
              <Tooltip label={t("home.product.areaTip", { name, n: a.proven, m: a.total })} focusable className="flex w-full items-center gap-3">
                <Ring share={share} size={40} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-13 font-semibold text-fg">{name}</span>
                  <span className="text-12 text-subtle">
                    {Math.round(share * 100)}% · {t("home.product.requirements", { n: a.requirements })}
                  </span>
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
