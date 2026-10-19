import { useCallback, useEffect, useState } from "react";

/** Minimal hash router: "#/projects/abc" → segments ["projects", "abc"]. */
export function useHashRoute(): [string[], (segments: string[]) => void] {
  const parse = useCallback((): string[] => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    return raw
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
  }, []);

  const [segments, setSegments] = useState<string[]>(parse);

  useEffect(() => {
    const onChange = () => setSegments(parse());
    window.addEventListener("hashchange", onChange);
    if (!window.location.hash) window.location.hash = "#/";
    return () => window.removeEventListener("hashchange", onChange);
  }, [parse]);

  const navigate = useCallback((next: string[]) => {
    window.location.hash = `#/${next.map(encodeURIComponent).join("/")}`;
  }, []);

  return [segments, navigate];
}
