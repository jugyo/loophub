import { parsePatchWithCoordinates } from "./diff-anchor.ts";
import type {
  SyntaxHighlightLineWire,
  SyntaxHighlightWire,
  SyntaxLanguageWire,
  SyntaxTokenKindWire,
  SyntaxTokenWire,
} from "./serialize.ts";

export type SyntaxLanguage = SyntaxLanguageWire;
export type SyntaxTokenKind = SyntaxTokenKindWire;

export interface SyntaxHighlightState {
  inBlockComment: boolean;
}

const JS_KEYWORDS =
  /\b(?:as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/g;
const JS_TYPES =
  /\b(?:any|bigint|boolean|never|null|number|object|string|symbol|unknown|undefined|void)\b/g;
const JS_LITERALS = /\b(?:false|NaN|true|undefined|null)\b/g;
const JS_TOKEN =
  /\/\/.*$|\/\*.*(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|<\/?[A-Za-z][^>]*\/?>|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:?~+\-*/%=<>!&|^]+/g;

const MARKDOWN_TOKEN =
  /^#{1,6}\s+.*$|^\s*>\s?|^\s*(?:[-+*]|\d+\.)\s+|^\s*```.*$|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]*\)|\*[^*]+\*|_[^_]+_/g;

const KEYWORDS = new Set(JS_KEYWORDS.source.match(/[A-Za-z]+/g) ?? []);
const TYPES = new Set(JS_TYPES.source.match(/[A-Za-z]+/g) ?? []);
const LITERALS = new Set(JS_LITERALS.source.match(/[A-Za-z]+/g) ?? []);

/** git の rename 表記を含むファイルパスから対応する highlighter を判定する。 */
export function detectSyntaxLanguage(
  filename: string | undefined | null,
): SyntaxLanguage | null {
  if (!filename) return null;
  const renameTarget = /=>\s*([^}]+)}?$/.exec(filename)?.[1];
  const path = (renameTarget ?? filename).replace(/[?#].*$/, "");
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "js":
      return "javascript";
    case "jsx":
      return "jsx";
    case "md":
    case "markdown":
      return "markdown";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    default:
      return null;
  }
}

function token(kind: SyntaxTokenKind, text: string): SyntaxTokenWire {
  return { kind, text };
}

function classifyJavaScriptToken(
  text: string,
  language: SyntaxLanguage,
): SyntaxTokenKind | null {
  if (text.startsWith("//") || text.startsWith("/*")) return "comment";
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
    return "string";
  }
  if (/^\d/.test(text)) return "number";
  if (language === "jsx" || language === "tsx") {
    if (/^<\/?[A-Za-z]/.test(text)) return "markup";
  }
  if (KEYWORDS.has(text)) return "keyword";
  if (TYPES.has(text)) return "type";
  if (LITERALS.has(text)) return "literal";
  if (/^[{}()[\].,;:?~+\-*/%=<>!&|^]+$/.test(text)) return "operator";
  return null;
}

export function tokenizeJavaScript(
  source: string,
  language: SyntaxLanguage,
  initialState: SyntaxHighlightState = { inBlockComment: false },
): { tokens: SyntaxTokenWire[]; state: SyntaxHighlightState } {
  const tokens: SyntaxTokenWire[] = [];
  let cursor = 0;
  let inBlockComment = initialState.inBlockComment;
  const matcher = new RegExp(JS_TOKEN.source, "g");

  while (cursor < source.length) {
    if (inBlockComment) {
      const end = source.indexOf("*/", cursor);
      if (end < 0) {
        tokens.push(token("comment", source.slice(cursor)));
        cursor = source.length;
        continue;
      }
      const commentEnd = end + 2;
      tokens.push(token("comment", source.slice(cursor, commentEnd)));
      cursor = commentEnd;
      inBlockComment = false;
      continue;
    }

    matcher.lastIndex = cursor;
    const match = matcher.exec(source);
    if (!match) {
      tokens.push(token("plain", source.slice(cursor)));
      break;
    }
    const text = match[0];
    const start = match.index;
    if (start > cursor)
      tokens.push(token("plain", source.slice(cursor, start)));
    const kind = classifyJavaScriptToken(text, language);
    tokens.push(kind ? token(kind, text) : token("plain", text));
    cursor = start + text.length;
    if (text.startsWith("/*") && !text.endsWith("*/")) {
      inBlockComment = true;
    }
  }
  return { tokens, state: { inBlockComment } };
}

export function tokenizeMarkdown(source: string): SyntaxTokenWire[] {
  const tokens: SyntaxTokenWire[] = [];
  let cursor = 0;
  for (const match of source.matchAll(MARKDOWN_TOKEN)) {
    const text = match[0];
    const start = match.index ?? 0;
    if (start > cursor)
      tokens.push(token("plain", source.slice(cursor, start)));
    tokens.push(token("markup", text));
    cursor = start + text.length;
  }
  if (cursor < source.length) tokens.push(token("plain", source.slice(cursor)));
  return tokens;
}

export function tokenizeSyntaxWithState(
  source: string,
  language: SyntaxLanguage,
  initialState: SyntaxHighlightState = { inBlockComment: false },
): { tokens: SyntaxTokenWire[]; state: SyntaxHighlightState } {
  return language === "markdown"
    ? { tokens: tokenizeMarkdown(source), state: initialState }
    : tokenizeJavaScript(source, language, initialState);
}

export function tokenizeSyntax(
  source: string,
  language: SyntaxLanguage,
): SyntaxTokenWire[] {
  return tokenizeSyntaxWithState(source, language).tokens;
}

function sourceLineHighlights(
  source: string | undefined,
  language: SyntaxLanguage,
): Array<{ tokens: SyntaxTokenWire[]; state: SyntaxHighlightState }> | null {
  if (source == null) return null;
  const result: Array<{
    tokens: SyntaxTokenWire[];
    state: SyntaxHighlightState;
  }> = [];
  let state: SyntaxHighlightState = { inBlockComment: false };
  for (const line of source.split("\n")) {
    const highlighted = tokenizeSyntaxWithState(line, language, state);
    result.push({ tokens: highlighted.tokens, state });
    state = highlighted.state;
  }
  return result;
}

/** ブラウザで解析せず unified diff を描画できる全 token 情報を生成する。 */
export function syntaxHighlightDiff(
  filename: string,
  patch: string,
  oldSource: string | undefined,
  newSource: string | undefined,
): SyntaxHighlightWire | null {
  const language = detectSyntaxLanguage(filename);
  if (!language) return null;
  const oldLines = sourceLineHighlights(oldSource, language);
  const newLines = sourceLineHighlights(newSource, language);
  if (!oldLines && !newLines) return null;

  const lines = parsePatchWithCoordinates(patch);
  const highlightedLines: SyntaxHighlightLineWire[] = lines.map((line) => {
    if (line.kind === "hunk" || line.kind === "meta") {
      return { old: null, new: null };
    }
    const code = line.text.slice(1);
    const old =
      line.leftLine != null && oldLines?.[line.leftLine - 1]
        ? oldLines[line.leftLine - 1].tokens
        : null;
    const next =
      line.rightLine != null && newLines?.[line.rightLine - 1]
        ? newLines[line.rightLine - 1].tokens
        : null;
    return {
      old:
        line.kind === "addition"
          ? null
          : (old ?? tokenizeSyntaxWithState(code, language).tokens),
      new:
        line.kind === "deletion"
          ? null
          : (next ?? tokenizeSyntaxWithState(code, language).tokens),
    };
  });

  return { language, lines: highlightedLines };
}
