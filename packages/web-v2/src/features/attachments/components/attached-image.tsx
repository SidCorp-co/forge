// An attached image that may not arrive: a file gone from storage, a link past its life, a read the
// network refused. The browser's broken-image glyph says none of that, and a thumbnail drawn with an
// empty alt says nothing at all, so a failed load draws the same box naming the file it could not
// load. A new `src` (the lightbox stepping on) tries again.

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

function Loaded({ src, alt, name, className, width, height, sizes, draggable, style }: AttachedImageProps) {
  const t = useCopy();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        role="img"
        aria-label={t("attachments.imageFailed", { name })}
        title={t("attachments.imageFailed", { name })}
        className={cn(className, "inline-flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 bg-sunken p-1.5 text-center text-11 leading-tight text-subtle")}
        data-testid="attached-image-failed"
      >
        <Icon name="alert" size={14} />
        <span className="line-clamp-2 break-all">{t("attachments.imageFailedShort")}</span>
      </span>
    );
  }
  return <img src={src} alt={alt} width={width} height={height} sizes={sizes} draggable={draggable} className={className} style={style} onError={() => setFailed(true)} />;
}
