// "New issue" button + guidance modal. Issues are created by an AI (Claude Code
// etc.) via the /loophub-issue-create skill, not by hand — so the button no
// longer opens a form. It points the user at the skill.
// The backend create API (useCreateIssue) stays for the skill/CLI to use.

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CreateIssueButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        New issue
      </Button>
      {open ? <CreateIssueGuideDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CreateIssueGuideDialog({ onClose }: { onClose: () => void }) {
  // Close on Escape, mirroring native dialog dismissal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
        className="flex max-h-[88vh] w-full max-w-xl flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New issue</h2>
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto text-sm">
          <p className="text-muted-foreground">
            Issue は Claude Code などの AI に作らせる運用です。会話の内容から
            skill が Goal・受け入れ条件まで整えて起票するため、ここで手入力する
            必要はありません。
          </p>
          <div className="flex flex-col gap-2">
            <p className="font-medium">skill で起票する</p>
            <p className="text-muted-foreground">
              Claude Code / Cursor で次の skill を実行します。
            </p>
            <code className="rounded-md border bg-muted px-3 py-2 font-mono text-xs">
              /loophub-issue-create
            </code>
            <p className="text-muted-foreground">
              起票したい内容を伝えると、AI が重複チェックのうえ issue を作成し、
              番号と URL を返します。
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </div>
  );
}
