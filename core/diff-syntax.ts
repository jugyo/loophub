import { type DiffFile, fileAtRef } from "./git.ts";
import type { SyntaxHighlightWire } from "./serialize.ts";
import {
  detectSyntaxLanguage,
  type SyntaxLanguage,
  syntaxHighlightDiff,
} from "./syntax-highlight.ts";

export type HighlightedDiffFile = DiffFile & {
  syntax_highlight?: SyntaxHighlightWire;
};

/** テキスト差分へ backend 生成の token 情報を付与する。 */
export async function addSyntaxHighlight<T extends DiffFile>(
  repoPath: string,
  baseSha: string,
  headSha: string,
  files: T[],
): Promise<Array<T & { syntax_highlight?: SyntaxHighlightWire }>> {
  return Promise.all(
    files.map(
      async (file): Promise<T & { syntax_highlight?: SyntaxHighlightWire }> => {
        const path = file.headFilename ?? file.filename;
        const language = syntaxLanguageFor(path);
        if (!language) return file;

        const oldPath = file.previousFilename ?? file.filename;
        const newPath = file.headFilename ?? file.filename;
        const [oldFile, newFile] = await Promise.all([
          fileAtRef(repoPath, baseSha, oldPath),
          fileAtRef(repoPath, headSha, newPath),
        ]);
        const syntax = syntaxHighlightDiff(
          path,
          file.patch,
          oldFile.status === "ok" ? oldFile.content : undefined,
          newFile.status === "ok" ? newFile.content : undefined,
        );
        return syntax ? { ...file, syntax_highlight: syntax } : file;
      },
    ),
  );
}

function syntaxLanguageFor(filename: string): SyntaxLanguage | null {
  return detectSyntaxLanguage(filename);
}
