"use client";

import { Select } from "@/design";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";

/** A room picker: a select over known rooms, else a raw rid input. */
export function RoomSelect({
  rooms,
  value,
  onChange,
  fallback,
}: {
  rooms: { rid: string; name: string; type?: string }[];
  value: string;
  onChange: (rid: string) => void;
  fallback: ReactNode;
}) {
  const t = useCopy();
  if (rooms.length === 0) return <>{fallback}</>;
  return (
    <div className="min-w-0 flex-1">
      <Select
        placeholder={t("integrations.rocket.pickRoom")}
        value={value}
        onChange={onChange}
        options={rooms.map((r) => ({
          value: r.rid,
          label: r.type === "p" ? t("integrations.rocket.privateRoom", { name: r.name }) : r.name,
        }))}
      />
    </div>
  );
}
