// The requirement page's tabs (ISS-903): at phone width they never wrap onto a second row. The
// Overview and the tab that is open stand as tabs; the rest wait behind one "More" menu beside them,
// each with its count, and choosing one opens it as a tab. Wider, every tab stands.

import { Button, DetailTabs, Menu, useMediaQuery } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

interface Tab<T extends string> {
  value: T;
  label: string;
  count?: number | undefined;
}

export function RequirementTabs<T extends string>({ tabs, value, onTab }: { tabs: Tab<T>[]; value: T; onTab: (t: T) => void }) {
  const t = useCopy();
  const narrow = useMediaQuery("(max-width: 767.98px)");
  if (!narrow) return <DetailTabs tabs={tabs} value={value} onChange={onTab} testId="requirement-tabs" />;
  const shown = tabs.filter((x, i) => i === 0 || x.value === value);
  const rest = tabs.filter((x) => !shown.includes(x));
  return (
    <div className="flex min-w-0 items-end gap-1" data-testid="requirement-tabs-narrow">
      <div className="min-w-0 flex-1">
        <DetailTabs tabs={shown} value={value} onChange={onTab} testId="requirement-tabs" />
      </div>
      {rest.length > 0 ? (
        <Menu
          trigger={
            <Button variant="ghost" size="sm" icon="chevronDown" data-testid="requirement-tabs-more">
              {t("common.moreTabs")}
            </Button>
          }
          items={rest.map((x) => ({ label: x.count ? `${x.label} · ${x.count}` : x.label, onSelect: () => onTab(x.value) }))}
        />
      ) : null}
    </div>
  );
}
