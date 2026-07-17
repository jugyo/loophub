import { createRoute } from "@tanstack/react-router";
import { Check, GitPullRequest, Moon, Palette, Play, Sun } from "lucide-react";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getThemeDefinition,
  THEME_TOKEN_KEYS,
  THEMES,
  type Theme,
  type ThemeTokenKey,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { rootRoute } from "./root";

type ThemeStyle = CSSProperties & Record<`--${ThemeTokenKey}`, string>;

function makeThemeStyle(theme: Theme): ThemeStyle {
  const definition = getThemeDefinition(theme);
  const style = {} as ThemeStyle;

  for (const key of THEME_TOKEN_KEYS) {
    style[`--${key}`] = definition.tokens[key];
  }

  return style;
}

function ThemePicker({
  portalContainer,
  theme,
  onThemeChange,
}: {
  portalContainer: HTMLElement | null;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const activeTheme = getThemeDefinition(theme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          aria-label="Catalog theme"
          className="border bg-background shadow-sm"
        >
          <Palette
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {activeTheme.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60"
        portalContainer={portalContainer}
      >
        {THEMES.map((candidate) => {
          const selected = candidate.id === theme;
          const Icon = candidate.appearance === "dark" ? Moon : Sun;

          return (
            <DropdownMenuItem
              key={candidate.id}
              onSelect={() => onThemeChange(candidate.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "min-h-11 justify-between gap-3",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {candidate.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {candidate.description}
                  </span>
                </span>
              </span>
              {selected ? (
                <Check className="size-4 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UiCatalogPage() {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [theme, setTheme] = useState<Theme>("light");
  const themeDefinition = getThemeDefinition(theme);
  const themeStyle = useMemo(() => makeThemeStyle(theme), [theme]);

  return (
    <div
      ref={setPortalContainer}
      data-debug-component="UiCatalogPage"
      className={cn(
        "min-h-screen bg-background text-foreground",
        themeDefinition.appearance === "dark" && "dark",
      )}
      data-catalog-theme={theme}
      style={themeStyle}
    >
      <main className="mx-auto flex w-full max-w-content-wide flex-col gap-8 px-8 py-8">
        <header className="flex items-start justify-between gap-6 border-b pb-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">
              LoopHub UI catalog
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal">
              Components and theme tokens
            </h1>
          </div>
          <ThemePicker
            portalContainer={portalContainer}
            theme={theme}
            onThemeChange={setTheme}
          />
        </header>

        <section className="grid grid-cols-[minmax(0,1fr)_20rem] gap-6">
          <div className="space-y-6">
            <section className="rounded-md border bg-card p-5 text-card-foreground">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold">Buttons</h2>
                <Badge tone="agent">interactive</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button">
                  <Play className="size-4" aria-hidden="true" />
                  Start build
                </Button>
                <Button type="button" variant="secondary">
                  Secondary action
                </Button>
                <Button type="button" variant="ghost">
                  Ghost action
                </Button>
                <Button type="button" disabled>
                  Disabled
                </Button>
              </div>
            </section>

            <section className="rounded-md border bg-card p-5 text-card-foreground">
              <h2 className="mb-4 text-base font-semibold">Status badges</h2>
              <div className="flex flex-wrap gap-2">
                <Badge tone="open">open</Badge>
                <Badge tone="working">working</Badge>
                <Badge tone="review-passed">review passed</Badge>
                <Badge tone="review-changes">changes requested</Badge>
                <Badge tone="draft">draft</Badge>
                <Badge tone="merged">merged</Badge>
              </div>
            </section>

            <section className="rounded-md border bg-card p-5 text-card-foreground">
              <h2 className="mb-4 text-base font-semibold">Issue row sample</h2>
              <div className="flex items-center justify-between gap-5 rounded-md border bg-background px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <GitPullRequest
                      className="size-4 text-link"
                      aria-hidden="true"
                    />
                    <span>#1030</span>
                    <span className="truncate">
                      Add a standalone UI catalog page
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Previewing controls, badges, surfaces, and theme contrast.
                  </p>
                </div>
                <Badge tone="open">ready-to-build</Badge>
              </div>
            </section>
          </div>

          <aside className="rounded-md border bg-card p-5 text-card-foreground">
            <h2 className="text-base font-semibold">Theme tokens</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {themeDefinition.description}
            </p>
            <div className="mt-5 space-y-3">
              {[
                ["Background", "bg-background"],
                ["Card", "bg-card"],
                ["Primary", "bg-primary"],
                ["Accent", "bg-accent"],
                ["Muted", "bg-muted"],
                ["Destructive", "bg-destructive"],
              ].map(([label, className]) => (
                <div key={label} className="flex items-center gap-3">
                  <span
                    className={cn("size-8 rounded-md border", className)}
                    aria-hidden="true"
                  />
                  <span className="text-sm">{label}</span>
                </div>
              ))}
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

export const uiCatalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__ui",
  component: UiCatalogPage,
});
