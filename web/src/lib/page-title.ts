import { useEffect } from "react";

const APP_TITLE = "LoopHub";

export function formatPageTitle(parts: readonly string[]): string {
  const cleaned = parts.filter((part) => part.trim().length > 0);
  return cleaned.length === 0 ? APP_TITLE : `${cleaned.join(" · ")} · ${APP_TITLE}`;
}

export function usePageTitle(parts: readonly string[]) {
  const title = formatPageTitle(parts);

  useEffect(() => {
    document.title = title;
  }, [title]);
}
