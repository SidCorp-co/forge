export async function raceWithTimeout<T>(probe: Promise<T>, ms: number): Promise<T | null> {
  const deadline = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
  });
  probe.catch(() => {});
  return Promise.race([probe, deadline]);
}
