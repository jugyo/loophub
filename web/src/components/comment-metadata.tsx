import type { IssueComment } from "@/api/types";
import { CommentAuthorLabel } from "@/components/comment-author-label";
import { CommentId } from "@/components/comment-id";
import { commentAuthor } from "@/lib/comment-author";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export function CommentMetadata({
  author,
  authorType,
  createdAt,
  id,
  className,
}: {
  author: string;
  authorType: IssueComment["author_type"];
  createdAt: string;
  id: number;
  className?: string;
}) {
  const authorLabel = `@${commentAuthor({
    user: { login: author },
    author_type: authorType,
  })}`;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1",
        className,
      )}
    >
      <span
        className="min-w-0 max-w-80 truncate text-sm font-medium"
        title={authorLabel}
      >
        <CommentAuthorLabel author={author} authorType={authorType} />
      </span>
      <time
        dateTime={createdAt}
        className="shrink-0 text-xs text-muted-foreground"
      >
        {relativeTime(createdAt)}
      </time>
      <CommentId id={id} />
    </div>
  );
}
