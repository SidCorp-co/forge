"use client";

import type { ReactNode } from "react";

const words = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

function Value({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  if (typeof value === "boolean") return <span>{value ? "yes" : "no"}</span>;
  if (typeof value === "string" || typeof value === "number") {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return <span className="break-words">{value.join(", ")}</span>;
    return (
      <ul className="space-y-2">
        {value.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a document's list has no ids and never reorders
          <li key={i} className="rounded-sm border border-line px-2 py-1">
            <Value value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="space-y-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="fg-caption">{words(k)}</dt>
            <dd className="text-13-5">
              {k === "payload" ? (
                <pre className="overflow-x-auto rounded-sm bg-sunken p-2 font-mono text-12">{JSON.stringify(v, null, 2)}</pre>
              ) : (
                <Value value={v} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

/** A document's body, field by field in the order core holds it. */
export function DocumentBody({ body }: { body: Record<string, unknown> }) {
  return (
    <dl className="space-y-3">
      {Object.entries(body).map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="fg-label text-fg">{words(k)}</dt>
          <dd className="mt-0.5 text-13-5">
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
