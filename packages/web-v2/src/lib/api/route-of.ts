// A contracts route (`/api/boxes/:id/take`) filled with its params, as `apiClient` takes it: each
// `:name` encoded, and the `/api` prefix the client adds itself dropped. A param the route names and
// the caller did not pass is refused by name, never filled with nothing.

export function routeOf(route: string, params: Record<string, string>): string {
  const path = route.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${route} needs :${name}`);
    return encodeURIComponent(value);
  });
  return path.replace(/^\/api/, "");
}
