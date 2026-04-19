import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

const lightComponents = {
  ul: ({ children }: any) => <ul className="ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  p: ({ children }: any) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
  h1: ({ children }: any) => <h1 className="font-bold text-base mb-1">{children}</h1>,
  h2: ({ children }: any) => <h2 className="font-bold text-sm mb-1">{children}</h2>,
  h3: ({ children }: any) => <h3 className="font-semibold text-sm mb-1">{children}</h3>,
  code: ({ children, className }: any) => {
    if (className?.includes("language-")) return <code className={className}>{children}</code>;
    return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-pink-600">{children}</code>;
  },
  pre: ({ children }: any) => <pre className="my-2 overflow-x-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100">{children}</pre>,
  a: ({ children, href }: any) => <a href={href} className="text-blue-600 underline hover:text-blue-800" target="_blank" rel="noopener noreferrer">{children}</a>,
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-gray-300 pl-3 text-gray-500 italic">{children}</blockquote>,
};

const darkClasses =
  "font-mono text-sm leading-relaxed text-[#cccccc] " +
  "prose prose-sm max-w-none " +
  "[&_h1]:text-[#a8d4ff] [&_h2]:text-[#a8d4ff] [&_h3]:text-[#a8d4ff] [&_h4]:text-[#a8d4ff] " +
  "[&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm " +
  "[&_h1]:font-mono [&_h2]:font-mono [&_h3]:font-mono " +
  "[&_p]:text-[#cccccc] [&_p]:my-1 " +
  "[&_li]:text-[#cccccc] [&_li]:my-0 [&_ul]:my-1 [&_ol]:my-1 " +
  "[&_strong]:text-[#a8d4ff] [&_em]:text-[#cccccc] " +
  "[&_a]:text-[#a8d4ff] [&_a]:underline " +
  "[&_pre]:!bg-[#0a0a0a] [&_pre]:text-[#cccccc] [&_pre]:rounded [&_pre]:border [&_pre]:border-[#333333] [&_pre]:my-1 " +
  "[&_.hljs]:!bg-[#0a0a0a] " +
  "[&_code]:text-[#a8d4ff] [&_code]:before:content-none [&_code]:after:content-none [&_code]:font-mono " +
  "[&_hr]:border-[#333333] [&_hr]:my-2 " +
  "[&_blockquote]:border-[#444444] [&_blockquote]:text-[#888888]";

interface MarkdownProps {
  children: string;
  theme?: "light" | "dark";
}

export function Markdown({ children, theme = "light" }: MarkdownProps) {
  if (theme === "dark") {
    return (
      <div className={darkClasses}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {children}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="text-sm text-gray-600 prose prose-sm max-w-none">
      <ReactMarkdown components={lightComponents}>{children}</ReactMarkdown>
    </div>
  );
}

export { lightComponents as mdLightComponents };
