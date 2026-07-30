// React binding for the theme module. Theme classes are already on <html>
// (set by the inline FOUC guard); this hook tracks and updates the selection.

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/error-message";
import {
  applyTheme,
  getThemeDefinition,
  resolveInitialTheme,
  type Theme,
} from "@/lib/theme";
import { useSettings, useUpdateSettings } from "@/queries/settings";

export function useTheme(): {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
} {
  const settings = useSettings();
  const { mutate: updateSettings } = useUpdateSettings();
  const { showError } = useToast();
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveInitialTheme(settings.data?.theme),
  );

  const selectTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      applyTheme(next);
      updateSettings(
        { theme: next },
        {
          onError: (error) =>
            showError(errorMessage(error, "Failed to save theme")),
        },
      );
    },
    [showError, updateSettings],
  );

  // settings.updated events invalidate this query, so selections made in
  // another tab arrive through the same server-backed read path.
  useEffect(() => {
    if (!settings.data) return;
    const next = resolveInitialTheme(settings.data.theme);
    setThemeState(next);
    applyTheme(next);
  }, [settings.data]);

  const toggle = useCallback(() => {
    selectTheme(
      getThemeDefinition(theme).appearance === "dark" ? "light" : "dark",
    );
  }, [selectTheme, theme]);

  return { theme, setTheme: selectTheme, toggle };
}
