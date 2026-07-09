import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("gives disabled buttons a shared non-interactive visual treatment", () => {
    const classes = cn(buttonVariants());

    expect(classes).toContain("disabled:cursor-not-allowed");
    expect(classes).toContain("disabled:ring-muted-foreground/30");
    expect(classes).toContain("disabled:hover:text-accent-foreground");
  });

  it("resets hover and active colors for non-primary disabled variants", () => {
    const secondary = cn(buttonVariants({ variant: "secondary" }));
    const ghost = cn(buttonVariants({ variant: "ghost" }));

    expect(secondary).toContain("disabled:bg-muted/40");
    expect(secondary).toContain("disabled:text-muted-foreground");
    expect(secondary).toContain("disabled:hover:bg-muted/40");
    expect(secondary).toContain("disabled:active:bg-muted/40");
    expect(ghost).toContain("disabled:bg-muted/40");
    expect(ghost).toContain("disabled:text-muted-foreground");
    expect(ghost).toContain("disabled:hover:bg-muted/40");
    expect(ghost).toContain("disabled:hover:text-muted-foreground");
    expect(ghost).toContain("disabled:active:bg-muted/40");
  });
});
