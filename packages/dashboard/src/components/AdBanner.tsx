import { useEffect, useRef } from "react";

/**
 * Adsterra display banner. Renders nothing unless VITE_ADSTERRA_KEY is set
 * (paste the `key` from your Adsterra banner code; the invoke.js host follows
 * from it). Sized in Adsterra's dashboard when you create the unit.
 */
export function AdBanner({ width = 300, height = 250 }: { width?: number; height?: number }) {
  const key = import.meta.env.VITE_ADSTERRA_KEY as string | undefined;
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!key || !slot.current) return;
    const container = slot.current;
    // Adsterra's invoke.js reads window.atOptions at load time.
    (window as { atOptions?: unknown }).atOptions = { key, format: "iframe", height, width, params: {} };
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = `//www.highperformanceformat.com/${encodeURIComponent(key)}/invoke.js`;
    container.appendChild(script);
    return () => {
      (window as { atOptions?: unknown }).atOptions = undefined;
      container.replaceChildren();
    };
  }, [key, width, height]);

  if (!key) return null;
  return (
    <div className="ad-slot" style={{ width, height }}>
      <div ref={slot} />
    </div>
  );
}
