// Bridges a detail page's heading to the breadcrumb header. A detail page
// registers its title and attaches the returned ref to its body <h1>; while
// that heading is visible the breadcrumb hides the title, and once it scrolls
// out of view the breadcrumb reveals it (see <AppBreadcrumb>). The context
// defaults to a no-op so detail components render fine without a provider
// (e.g. in unit tests).

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface DetailTitleContextValue {
  /** Title of the issue/PR currently shown, or null when not on a detail page. */
  title: string | null;
  /** True while the page body's own <h1> is visible in the scroll viewport. */
  bodyVisible: boolean;
  setTitle: (title: string | null) => void;
  setBodyVisible: (visible: boolean) => void;
}

const noop = () => {};

export const DetailTitleContext = createContext<DetailTitleContextValue>({
  title: null,
  bodyVisible: true,
  setTitle: noop,
  setBodyVisible: noop,
});

export function DetailTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [bodyVisible, setBodyVisible] = useState(true);

  return (
    <DetailTitleContext.Provider
      value={{ title, bodyVisible, setTitle, setBodyVisible }}
    >
      {children}
    </DetailTitleContext.Provider>
  );
}

/** Read the breadcrumb title state (used by the header). */
export function useDetailTitle() {
  return useContext(DetailTitleContext);
}

/**
 * Register a detail page's title with the breadcrumb header and observe the
 * body heading. Attach the returned ref to the body <h1>: while that heading
 * intersects the scroll viewport the breadcrumb stays hidden; once it scrolls
 * out of view the breadcrumb reveals the title.
 */
export function useRegisterDetailTitle(title: string) {
  const { setTitle, setBodyVisible } = useContext(DetailTitleContext);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Publish the title; assume the body heading is visible until the observer
  // says otherwise (avoids a flash of the breadcrumb title on navigation).
  useEffect(() => {
    setTitle(title);
    setBodyVisible(true);
    return () => setTitle(null);
  }, [title, setTitle, setBodyVisible]);

  useEffect(() => {
    const el = headingRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.closest("main");
    const observer = new IntersectionObserver(
      ([entry]) => setBodyVisible(entry.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [setBodyVisible]);

  return headingRef;
}
