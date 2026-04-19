import { useState, useRef, useEffect } from "react";

export function useChangedIds<T extends { id: number; documentId: string; status: string; updatedAt: string }>(items: T[]) {
  const prevRef = useRef<Map<string, string>>(new Map());
  const [changedIds, setChangedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const prev = prevRef.current;
    const next = new Map(items.map((i) => [i.documentId, `${i.status}|${i.updatedAt}`]));
    const changed = new Set<string>();
    for (const [id, val] of next) {
      const prevVal = prev.get(id);
      if (prevVal !== undefined && prevVal !== val) changed.add(id);
      if (prevVal === undefined && prev.size > 0) changed.add(id);
    }
    prevRef.current = next;
    if (changed.size > 0) {
      setChangedIds(changed);
      const timer = setTimeout(() => setChangedIds(new Set()), 1500);
      return () => clearTimeout(timer);
    }
  }, [items]);

  return changedIds;
}
