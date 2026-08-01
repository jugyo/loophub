export function CommentId({ id }: { id: number }) {
  return (
    <span
      className="font-mono text-xs font-normal text-muted-foreground"
      aria-label={`Comment ID ${id}`}
    >
      #{id}
    </span>
  );
}
