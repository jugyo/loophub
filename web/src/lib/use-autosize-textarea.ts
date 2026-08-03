import { useLayoutEffect, useRef } from "react";

export function useAutosizeTextarea(value: string) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const borderHeight = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
  }, [value]);

  return textareaRef;
}
