// shadcn/ui Button. Minimal variant set used by the app shell.

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const disabledButtonStateClasses =
  "disabled:cursor-not-allowed disabled:bg-muted/40 disabled:text-muted-foreground disabled:shadow-none disabled:ring-1 disabled:ring-inset disabled:ring-muted-foreground/30 disabled:hover:bg-muted/40 disabled:hover:text-muted-foreground disabled:active:bg-muted/40";

const disabledIconButtonStateClasses =
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:active:bg-transparent";

const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${disabledButtonStateClasses}`,
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:bg-primary-subtle disabled:text-accent-foreground disabled:hover:bg-primary-subtle disabled:hover:text-accent-foreground disabled:active:bg-primary-subtle",
        ghost:
          "hover:bg-accent hover:text-accent-foreground disabled:hover:bg-muted/40 disabled:hover:text-muted-foreground disabled:active:bg-muted/40",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:hover:bg-muted/40 disabled:active:bg-muted/40",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      data-debug-component="Button"
    />
  ),
);
Button.displayName = "Button";

export {
  buttonVariants,
  disabledButtonStateClasses,
  disabledIconButtonStateClasses,
};
