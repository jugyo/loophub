import type { ReactNode } from "react";
import type {
  SyntaxHighlightLineWire,
  SyntaxLanguageWire,
  SyntaxTokenWire,
} from "../../../core/serialize.ts";

const TOKEN_CLASS: Record<SyntaxTokenWire["kind"], string> = {
  comment: "text-muted-foreground italic",
  keyword: "text-violet-700 dark:text-violet-300",
  literal: "text-orange-700 dark:text-orange-300",
  markup: "text-pink-700 dark:text-pink-300",
  number: "text-amber-700 dark:text-amber-300",
  operator: "text-cyan-700 dark:text-cyan-300",
  plain: "",
  string: "text-green-700 dark:text-green-300",
  type: "text-sky-700 dark:text-sky-300",
};

/** source code をブラウザで解析せず backend 生成の token 情報を描画する。 */
export function SyntaxHighlightedCode({
  code,
  language,
  tokens,
}: {
  code: string;
  language?: SyntaxLanguageWire;
  tokens?: SyntaxTokenWire[] | null;
}): ReactNode {
  if (!language || !tokens) return code;
  const preserveSourceText = tokens.length > 1;
  return (
    <span data-syntax-language={language}>
      {preserveSourceText ? <span className="sr-only">{code}</span> : null}
      <span aria-hidden={preserveSourceText || undefined}>
        {tokens.map((item, index) => (
          <span
            key={`${item.kind}:${index}`}
            className={TOKEN_CLASS[item.kind]}
            data-syntax-token={item.kind}
          >
            {item.text}
          </span>
        ))}
      </span>
    </span>
  );
}

export type SyntaxHighlightLine = SyntaxHighlightLineWire;
