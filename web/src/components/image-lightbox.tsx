// Full-size image lightbox for images embedded in Markdown bodies (#471). Modal chrome, focus
// trap, and wheel-zoom are shared with mermaid-diagram.tsx via <Lightbox> (see lightbox.tsx).

import { useState } from "react";
import { Lightbox } from "@/components/lightbox";

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [error, setError] = useState(false);

  return (
    <Lightbox ariaLabel={alt || "Image preview"} onClose={onClose}>
      {error ? (
        <div className="flex max-w-[90vw] flex-col items-center gap-4 rounded bg-background p-6 text-center shadow-2xl">
          <p role="alert" className="text-destructive">
            画像プレビューを読み込めませんでした。
          </p>
          <a href={src} className="text-link hover:underline">
            元の画像を開く
          </a>
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          className="max-h-[90vh] max-w-[90vw] select-none rounded object-contain shadow-2xl"
          draggable={false}
          onError={() => setError(true)}
        />
      )}
    </Lightbox>
  );
}
