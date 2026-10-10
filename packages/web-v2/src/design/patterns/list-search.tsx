
import { useCopy } from "@/lib/i18n/interface-language";
import { Icon } from "../icons/icon";

interface ListSearchProps {
  noun: string;
  value: string;
  onChange: (text: string) => void;
}

export function ListSearch({ noun, value, onChange }: ListSearchProps) {
  const t = useCopy();
  return (
    <label className="flex h-7.5 min-w-37.5 max-w-65 flex-1 items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 text-13 text-subtle max-md:h-10 max-md:max-w-none max-md:basis-full">
      <Icon name="search" size={14} />
      <input
        type="search"
        aria-label={t("common.searchNounLabel", { noun })}
        placeholder={t("common.searchNoun", { noun })}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 border-0 bg-transparent text-fg outline-none"
      />
    </label>
  );
}
