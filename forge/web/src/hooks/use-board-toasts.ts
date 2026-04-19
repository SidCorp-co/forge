import { useRef, useEffect } from 'react';

export function useCountChangeToast(count: number, label: string, addToast: (text: string) => void) {
  const prevCount = useRef(count);
  useEffect(() => {
    if (prevCount.current > 0 && count > prevCount.current) {
      addToast(`${count - prevCount.current} new ${label}(s) added`);
    }
    prevCount.current = count;
  }, [count, label, addToast]);
}

export function useChangedItemsToast(
  changedIds: Set<string>,
  items: { documentId: string; title: string }[],
  addToast: (text: string) => void,
) {
  useEffect(() => {
    if (changedIds.size === 0) return;
    const names = items.filter((i) => changedIds.has(i.documentId)).map((i) => i.title);
    if (names.length > 0) addToast(`Updated: ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`);
  }, [changedIds]); // eslint-disable-line react-hooks/exhaustive-deps
}
