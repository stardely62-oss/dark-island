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

/** The same colour turned around the colour wheel, for a second light. */
export function shiftHue(rgb: string, deg: number): string {
  const m = rgb.match(/[\d.]+/g);
  if (!m || m.length < 3) return rgb;
  const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + deg + 360) % 360;
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
}
