'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import { cn } from '@/lib/utils/cn';
import { mdComponents } from '@/lib/markdown-components';

interface Props {
  children: string;
  className?: string;
  /**
   * @deprecated theme branching dropped in ISS-311. The component now uses
   * Material You tokens that adapt to data-theme automatically. The prop is
   * kept for backwards-compat with existing call sites but is ignored.
   */
  theme?: 'light' | 'dark';
}

export function Markdown({ children, className }: Props) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <div
        className={cn(
          'prose prose-sm max-w-none break-words [overflow-wrap:anywhere]',
          'text-[13px] leading-relaxed text-on-surface',
          className,
        )}
        style={{
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={mdComponents}
        >
          {children}
        </ReactMarkdown>
      </div>
    </div>
  );
}
