import { AVATAR_HUE, type AvatarHue } from "@/design/status";

export interface AvatarProps {
  initials: string;
  hue?: AvatarHue;
  size?: number;
}

export function Avatar({ initials, hue = "cobalt", size = 24 }: AvatarProps) {
  const h = AVATAR_HUE[hue] ?? AVATAR_HUE.cobalt;
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-pill font-bold"
      style={{
        width: size,
        height: size,
        background: h.bg,
        color: h.fg,
        fontSize: size * 0.42,
        letterSpacing: "0.01em",
      }}
    >
      {initials}
    </span>
  );
}
