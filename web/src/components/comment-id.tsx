export function CommentId({ id }: { id: number }) {
  return (
    <span
      className="ml-auto shrink-0 font-mono text-xs font-normal text-muted-foreground"
      aria-label={`Comment ID ${id}`}
    >
      #{id}
    </span>
  );
}
