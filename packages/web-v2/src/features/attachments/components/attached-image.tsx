// An attached image that may not arrive: a file gone from storage, a link past its life, a read the
// network refused. The browser's broken-image glyph says none of that, and a thumbnail drawn with an
// empty alt says nothing at all, so a failed load draws the same box naming the file it could not
// load: by its name where the box is large enough to read one, by its label and tooltip on a
// thumbnail. A new `src` (the lightbox stepping on) tries again.

import { type CSSProperties, useState } from "react";
import { Icon } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

interface AttachedImageProps {
  src: string;
  /** What the image shows; "" where the control around it carries the name. */
  alt: string;
  /** The file's name, which the failed box reads. */
  name: string;
  /** A box large enough to read the file's name in, not only "Couldn't load". */
  large?: boolean;
  /** Drawn over the lightbox's dark backdrop, whatever the page's theme. */
  onDark?: boolean;
  className?: string;
  width?: number;
  height?: number;
  sizes?: string;
  draggable?: boolean;
  style?: CSSProperties;
}

export function AttachedImage(props: AttachedImageProps) {
  return <Loaded key={props.src} {...props} />;
}

function Loaded({ src, alt, name, large = false, onDark = false, className, width, height, sizes, draggable, style }: AttachedImageProps) {
  const t = useCopy();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        role="img"
        aria-label={t("attachments.imageFailed", { name })}
        title={t("attachments.imageFailed", { name })}
        className={cn(
          className,
          "inline-flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 p-1.5 text-center leading-tight",
          onDark ? "bg-black text-white/75" : "bg-sunken text-subtle",
          large ? "min-h-40 min-w-60 text-13" : "text-11",
        )}
        data-testid="attached-image-failed"
      >
        <Icon name="alert" size={large ? 18 : 14} />
        <span className={cn(large ? "line-clamp-3 max-w-80 break-words" : "line-clamp-2")}>
          {large ? t("attachments.imageFailed", { name }) : t("attachments.imageFailedShort")}
        </span>
      </span>
    );
  }
  return <img src={src} alt={alt} width={width} height={height} sizes={sizes} draggable={draggable} className={className} style={style} onError={() => setFailed(true)} />;
}
