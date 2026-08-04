// Archiving a comment (#2346) keeps it and collapses it: a settled exchange stops crowding the
// discussion without any history being deleted. Shared by the PR page's top-level comments and the
// diff view's conversations so both carry the same affordance and the same collapsed shape.

import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The three dots menu at a comment's top right, carrying its archive action. */
export function CommentActionsMenu({
  label,
  archived,
  busy,
  onArchived,
}: {
  label: string;
  archived: boolean;
  busy: boolean;
  onArchived: (archived: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-my-1 size-7 shrink-0"
          aria-label={label}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => onArchived(!archived)}
        >
          {archived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The first non-empty line of a comment body, for the collapsed one-line summary. */
export function commentPreview(body: string): string {
  return (
    body
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** An archived comment: one line by default, expandable to the full exchange. */
export function ArchivedComment({
  label,
  preview,
  menu,
  children,
}: {
  label: string;
  preview: string;
  menu: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={label}
          onClick={() => setExpanded((shown) => !shown)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <Chevron className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{preview}</span>
        </button>
        {menu}
      </div>
      {expanded ? children : null}
    </div>
  );
}
