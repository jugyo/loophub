import { type RefObject, useEffect, useRef } from "react";

// A posted comment lands at the bottom of a long timeline, so both it and the form that
// posted it can sit off-screen (#357). Scroll the form back into view once the post has
// actually rendered — the comment count is the render signal, not the mutation callback,
// so the scroll targets the layout that includes the new card. `block: "nearest"` keeps a
// form that is already visible exactly where it is.
export function useScrollToCommentForm(commentCount: number): {
  formRef: RefObject<HTMLDivElement | null>;
  scrollAfterPost: () => void;
} {
  const formRef = useRef<HTMLDivElement>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (!requested.current) return;
    requested.current = false;
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [commentCount]);

  return {
    formRef,
    scrollAfterPost: () => {
      requested.current = true;
    },
  };
}
