#!/usr/bin/env bash
# Renders the 9:16 promo video. Needs: the dev server (npm run dev, port 1420),
# Python 3 with numpy, Node with Playwright, ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"
python3 music.py                      # original track + its band levels
node record.cjs                       # frames from the island in the browser
python3 - <<'PY'
import json
d = json.load(open('frames.json')); st = d['stamps']; t0 = st[0]
with open('list.txt', 'w') as f:
    for i in range(len(st)):
        dur = (st[i + 1] - st[i]) if i + 1 < len(st) else 0.033
        f.write(f"file 'frames/f{i:05d}.jpg'\nduration {dur:.4f}\n")
    f.write(f"file 'frames/f{len(st) - 1:05d}.jpg'\n")
open('offset.txt', 'w').write(str(int((d['musicAt'] / 1000 - t0) * 1000)))
PY
MS=$(cat offset.txt)
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -i track.wav -filter_complex \
  "[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=49.6:d=0.8[v];[1:a]adelay=${MS}|${MS},apad,atrim=0:50.4,afade=t=out:st=48.4:d=2[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart -t 50.4 \
  dark-island-promo-9x16.mp4
echo "done: $(pwd)/dark-island-promo-9x16.mp4"
