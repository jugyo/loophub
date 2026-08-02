import type { IssueComment } from "@/api/types";
import { AgentBotIcon } from "@/components/agent-bot-icon";
import { commentAuthor } from "@/lib/comment-author";

type AuthorType = IssueComment["author_type"];

export function CommentAuthorLabel({
  author,
  authorType,
}: {
  author: string;
  authorType: AuthorType;
}) {
  const displayAuthor = commentAuthor({
    user: { login: author },
    author_type: authorType,
  });

  return (
    <span className="inline-flex items-center gap-1">
      {authorType === "agent" ? (
        <AgentBotIcon
          label="AI agent"
          className="bg-primary-subtle text-link"
        />
      ) : null}
      <span>@{displayAuthor}</span>
    </span>
  );
}
