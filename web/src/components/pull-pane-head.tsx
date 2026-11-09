import type { ReactNode } from "react";

/** The fixed title row of a right-pane view on the PR page; `children` trail after the title. */
export function PullPaneHead({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <h2 className="flex shrink-0 items-center gap-2 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </header>
  );
}
