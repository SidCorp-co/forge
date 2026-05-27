import { coreFileUrl } from '@/lib/api/client';

export const mdComponents = {
  // Render markdown images inline. Resolve relative core paths (e.g.
  // /api/attachments/:id/download) to the API origin, and cap width so a large
  // image is not clipped by the Markdown wrapper's overflow-hidden.
  img: ({ src, alt }: any) => (
    <img
      src={coreFileUrl(src ?? '')}
      alt={alt ?? ''}
      loading="lazy"
      className="my-2 h-auto max-w-full rounded-sm border border-outline-variant/30"
    />
  ),
  ul: ({ children }: any) => <ul className="ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  p: ({ children }: any) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
  h1: ({ children }: any) => <h1 className="font-bold text-base mb-1">{children}</h1>,
  h2: ({ children }: any) => <h2 className="font-bold text-sm mb-1">{children}</h2>,
  h3: ({ children }: any) => <h3 className="font-semibold text-sm mb-1">{children}</h3>,
  code: ({ children, className }: any) => {
    if (className?.includes('language-')) return <code className={className}>{children}</code>;
    return <code className="rounded bg-surface-container-high px-1.5 py-0.5 text-xs font-mono text-error">{children}</code>;
  },
  pre: ({ children }: any) => <pre className="my-2 max-w-full overflow-x-auto rounded-lg bg-surface p-3 text-xs text-on-surface">{children}</pre>,
  a: ({ children, href }: any) => <a href={href} className="text-info underline hover:text-info" target="_blank" rel="noopener noreferrer">{children}</a>,
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-outline-variant pl-3 text-on-surface-variant italic">{children}</blockquote>,
  table: ({ children }: any) => <div className="overflow-x-auto"><table className="min-w-full">{children}</table></div>,
};
