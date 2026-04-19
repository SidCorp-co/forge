'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import { cn } from '@/lib/utils/cn';
import { mdComponents } from '@/lib/markdown-components';

const darkComponents: Record<string, React.ComponentType<any>> = {
  ul: ({ children }: any) => <ul className="ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold text-primary">{children}</strong>,
  p: ({ children }: any) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
  h1: ({ children }: any) => <h1 className="font-bold text-base mb-1 text-[#a8d4ff]">{children}</h1>,
  h2: ({ children }: any) => <h2 className="font-bold text-sm mb-1 text-[#a8d4ff]">{children}</h2>,
  h3: ({ children }: any) => <h3 className="font-semibold text-sm mb-1 text-[#a8d4ff]">{children}</h3>,
  code: ({ children, className }: any) => {
    if (className?.includes('language-')) return <code className={className}>{children}</code>;
    return <code className="rounded bg-[#1a1a1a] px-1.5 py-0.5 text-xs font-mono text-[#e06c75]">{children}</code>;
  },
  pre: ({ children }: any) => <pre className="my-2 overflow-x-auto rounded-lg bg-[#0a0a0a] p-3 text-xs text-on-surface border border-[#222222]">{children}</pre>,
  a: ({ children, href }: any) => <a href={href} className="text-[#61afef] underline hover:text-[#82c4f8]" target="_blank" rel="noopener noreferrer">{children}</a>,
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-[#444444] pl-3 text-[#888888] italic">{children}</blockquote>,
  table: ({ children }: any) => <div className="overflow-x-auto"><table className="min-w-full">{children}</table></div>,
};

interface Props {
  children: string;
  className?: string;
  theme?: 'light' | 'dark';
}

export function Markdown({ children, className, theme = 'light' }: Props) {
  const isDark = theme === 'dark';

  const sansFont = isDark ? { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' } as const : undefined;

  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <div
        className={cn(
          'prose prose-sm max-w-none break-words [overflow-wrap:anywhere]',
          isDark && 'text-[13px] leading-relaxed text-[#cccccc]',
          className,
        )}
        style={sansFont}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={isDark ? [rehypeHighlight] : []}
          components={isDark ? darkComponents : mdComponents}
        >
          {children}
        </ReactMarkdown>
      </div>
    </div>
  );
}
