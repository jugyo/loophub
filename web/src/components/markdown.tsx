// Shared Markdown renderer for issue / PR / comment bodies. Bodies are persisted
// as plain Markdown source; we render them as GitHub Flavored Markdown here.
//
// XSS: react-markdown does not render raw HTML unless rehype-raw is added, which
// it is not. Any HTML embedded in a body is escaped and shown as literal text,
// so bodies cannot inject markup. Keep it that way — do not add rehype-raw.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("markdown-body", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
