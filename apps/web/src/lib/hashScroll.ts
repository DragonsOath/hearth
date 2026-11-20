import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Brings the section named in the address (#movie-nights) into view once the page has drawn it,
 * so a link to one part of a page lands there ("Open it for me", checklist 42.2).
 */
export function useScrollToHash(ready = true) {
  const { hash } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (!ready || !id) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 20) window.clearInterval(timer);
      el?.scrollIntoView({ block: "start" });
    }, 100);
    return () => window.clearInterval(timer);
  }, [hash, ready]);
}
