/**
 * Shared id + title block for issue/PR detail headers. Owning the spacing here
 * keeps the id→title margin and header layout identical across both pages.
 */
export function DetailHeaderTitle({
  kind,
  number,
  title,
}: {
  kind: "Issue" | "PR";
  number: number;
  title: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-medium text-muted-foreground">
        {kind} #{number}
      </span>
      <h1 className="text-2xl font-semibold">{title}</h1>
    </div>
  );
}
