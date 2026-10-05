// A module's ports: what the composition root provides at boot, read on first call rather than at
// import, so a module never loads the one it depends on. `port(key)` answers a function that forwards
// to the provided one, typed as it.
export function portSlot<P extends object>(module: string, provider: string) {
  let given: P | null = null;
  const get = (): P => {
    if (!given) {
      throw new Error(
        `${module}: no ports were provided; the process entry calls ${provider} before it serves`,
      );
    }
    return given;
  };
  const port = <K extends keyof P>(key: K): P[K] =>
    ((...args: unknown[]) => (get()[key] as (...a: unknown[]) => unknown)(...args)) as P[K];
  return {
    provide: (ports: P): void => {
      given = ports;
    },
    get,
    port,
  };
}
