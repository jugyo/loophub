// React binding for the theme module. The `dark` class is already on <html>
// (set by the inline FOUC guard); this hook tracks it as state and flips it.

import { useCallback, useState } from "react";
import { resolveInitialTheme, setTheme, type Theme } from "@/lib/theme";

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      setTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
