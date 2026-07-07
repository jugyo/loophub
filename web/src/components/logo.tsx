import type { SVGProps } from "react";

// LoopHub mark: a circular loop-arrow (the dev loop that keeps iterating) around a central
// hub node (the supervised center). Geometric system, all concentric at (16,16): annular
// band r9–r13; wedge back edge radial; tip extended along the wedge's lower edge; tail cut
// parallel to that lower edge. Uses `currentColor` so the mark follows the surrounding text
// color in both themes; the hub node follows the primary theme token.
export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="LoopHub"
      {...props}
    >
      <path
        d="M27.43 9.8 A13 13 0 1 1 16 3 L16 1.5 L22.63 6.05 L16 8.5 L16 7 A9 9 0 1 0 23.62 11.21 Z"
        fill="currentColor"
      />
      <circle cx="16" cy="16" r="4.5" fill="hsl(var(--primary))" />
    </svg>
  );
}
