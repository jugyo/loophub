// Placeholder page body for app-shell routes. Later UI issues replace these
// with real screens (home/dashboard, issue/pull lists and details, etc.).

export function PagePlaceholder({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {description ?? "Content lands in a later UI issue."}
      </p>
    </div>
  );
}
