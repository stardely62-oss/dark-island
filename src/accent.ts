import { useEffect, useState } from "react";

/** A vivid colour from the album art, bright enough to read on black. */
export function useAccent(src: string | null): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!src) {
      setColor(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const max = Math.max(d[i], d[i + 1], d[i + 2]);
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        const sat = max === 0 ? 0 : (max - min) / max;
        const w = 0.05 + sat * sat * (max / 255); // favour saturated, bright pixels
        r += d[i] * w;
        g += d[i + 1] * w;
        b += d[i + 2] * w;
        wsum += w;
      }
      [r, g, b] = [r / wsum, g / wsum, b / wsum];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < 120) {
        const k = 120 / Math.max(lum, 1);
        [r, g, b] = [Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)];
      }
      setColor(`rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return color;
}
