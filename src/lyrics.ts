/** "[01:23.45] line" → sorted [{ t: ms, text }] */
export type Line = { t: number; text: string };

export function parseLrc(lrc: string): Line[] {
  const out: Line[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) out.push({ t: (Number(s[1]) * 60 + Number(s[2])) * 1000, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function lineAt(lines: Line[], ms: number): number {
  let i = -1;
  for (let k = 0; k < lines.length && lines[k].t <= ms + 150; k++) i = k;
  return i;
}
