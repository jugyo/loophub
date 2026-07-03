// Full-size image lightbox for images embedded in Markdown bodies (#471). Modal chrome, focus
// trap, and wheel-zoom are shared with mermaid-diagram.tsx via <Lightbox> (see lightbox.tsx).

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
  return (
    <Lightbox ariaLabel={alt || "Image preview"} onClose={onClose}>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] select-none rounded object-contain shadow-2xl"
        draggable={false}
      />
    </Lightbox>
  );
}
