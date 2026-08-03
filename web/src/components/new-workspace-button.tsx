import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { useCreateWorkspace } from "@/queries/workspaces";

export function NewWorkspaceButton({
  owner,
  repo,
  size,
}: {
  owner: string;
  repo: string;
  size?: ButtonProps["size"];
}) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const create = useCreateWorkspace(owner, repo);

  function close() {
    if (create.isPending) return;
    setOpen(false);
    setBranch("");
    create.reset();
  }

  const backdropDismiss = useBackdropDismiss(close);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  async function submit() {
    try {
      await create.mutateAsync(branch);
    } catch {
      return;
    }
    close();
  }

  return (
    <>
      <div data-debug-component="NewWorkspaceButton" className="inline-flex">
        <Button
          type="button"
          variant="secondary"
          size={size}
          onClick={() => setOpen(true)}
        >
          <Plus className="size-4" />
          New
        </Button>
      </div>
      {open
        ? // Portal to the body so the fixed overlay is viewport-relative even when
          // the trigger lives inside a transformed container (the workspace filter
          // dropdown, #1511), where `position: fixed` would otherwise anchor to it.
          createPortal(
            <div
              className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
              {...backdropDismiss}
            >
              <form
                data-debug-component="NewWorkspaceDialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="new-workspace-title"
                className="flex w-full max-w-md flex-col rounded-lg border bg-background p-5 shadow-lg"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!create.isPending) submit();
                }}
              >
                <h2 id="new-workspace-title" className="text-lg font-semibold">
                  New workspace
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create a new branch from the default branch.
                </p>
                <label className="mt-4 flex flex-col gap-1 text-sm">
                  <span className="font-medium">Branch name</span>
                  <input
                    type="text"
                    autoFocus
                    required
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </label>
                {create.error ? (
                  <p role="alert" className="mt-3 text-sm text-destructive">
                    {errorMessage(create.error)}
                  </p>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={create.isPending}
                    onClick={close}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? "Creating…" : "Create workspace"}
                  </Button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
