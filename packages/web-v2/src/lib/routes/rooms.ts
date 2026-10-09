export const roomHref = (slug: string, roomId: string) =>
  `/projects/${encodeURIComponent(slug)}/rooms/${encodeURIComponent(roomId)}`;
