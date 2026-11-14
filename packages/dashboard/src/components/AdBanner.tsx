import { useEffect, useRef } from "react";

/**
 * Adsterra display banner. Renders nothing unless VITE_ADSTERRA_KEY is set.
 * VITE_ADSTERRA_SRC (full script URL) overrides the default invoke.js host —
 * Adsterra rotates script hosts per unit (e.g. bauval.org/22/<key>).
 */
export function AdBanner({ width = 300, height = 250 }: { width?: number; height?: number }) {
  const key = import.meta.env.VITE_ADSTERRA_KEY as string | undefined;
  const src = import.meta.env.VITE_ADSTERRA_SRC as string | undefined;
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!key || !slot.current) return;
    const container = slot.current;
    // Adsterra's script reads window.atOptions at load time.
    (window as { atOptions?: unknown }).atOptions = { key, format: "iframe", height, width, params: {} };
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = src ?? `//www.highperformanceformat.com/${encodeURIComponent(key)}/invoke.js`;
    container.appendChild(script);
    return () => {
      (window as { atOptions?: unknown }).atOptions = undefined;
      container.replaceChildren();
    };
  }, [key, src, width, height]);

  if (!key) return null;
  return (
    <div className="ad-slot" style={{ width, height }}>
      <div ref={slot} />
    </div>
  );
}
