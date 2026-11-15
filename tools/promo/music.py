# An original 120 bpm synthwave-ish loop, generated from scratch (no samples).
import numpy as np, wave, json
SR = 44100
BPM = 120
beat = 60 / BPM
DUR = 50.0
N = int(SR * DUR)
t = np.arange(N) / SR
out = np.zeros(N)
rng = np.random.default_rng(7)

def env(n, a=0.005, d=0.2):
    x = np.arange(n) / SR
    return np.minimum(1, x / a) * np.exp(-x / d)

def place(sig, start):
    i = int(start * SR)
    if i >= N: return
    j = min(N, i + len(sig))
    out[i:j] += sig[: j - i]

# kick
def kick():
    n = int(0.35 * SR); x = np.arange(n) / SR
    f = 50 + 110 * np.exp(-x * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-x * 7) * 0.9
# snare / clap
def snare():
    n = int(0.25 * SR); x = np.arange(n) / SR
    noise = rng.uniform(-1, 1, n)
    tone = np.sin(2 * np.pi * 190 * x)
    return (0.5 * noise + 0.3 * tone) * np.exp(-x * 18) * 0.45
def hat(open_=False):
    n = int((0.2 if open_ else 0.05) * SR); x = np.arange(n) / SR
    noise = rng.uniform(-1, 1, n)
    noise = np.diff(np.concatenate([[0], noise]))  # brighter
    return noise * np.exp(-x * (12 if open_ else 60)) * 0.18

def saw(freq, n):
    x = np.arange(n) / SR
    s = np.zeros(n)
    for k in range(1, 12):
        s += np.sin(2 * np.pi * freq * k * x) / k
    return s * 0.5

chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G
mid = lambda m: 440 * 2 ** ((m - 69) / 12)
bars_total = int(DUR / (4 * beat))
for bar in range(bars_total):
    b0 = bar * 4 * beat
    ch = chords[bar % 4]
    intro = bar < 2
    # pad
    n = int(4 * beat * SR)
    pad = sum(saw(mid(m), n) for m in ch) / 3
    pad *= np.minimum(1, np.arange(n) / (0.3 * SR)) * np.minimum(1, (n - np.arange(n)) / (0.3 * SR))
    place(pad * 0.16, b0)
    for q in range(4):
        tb = b0 + q * beat
        if not intro or q % 2 == 0:
            place(kick(), tb)
        if not intro and q in (1, 3):
            place(snare(), tb)
        for e in range(2):
            place(hat(open_=(e == 1 and q == 3)), tb + e * beat / 2)
        # bass: root, eighth notes
        if not intro:
            for e in range(2):
                bn = int(beat / 2 * SR * 0.9)
                bs = saw(mid(ch[0] - 24), bn) * env(bn, 0.003, 0.18)
                place(bs * 0.35, tb + e * beat / 2)
    # arp lead from bar 4
    if bar >= 4:
        notes = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12]
        for s16 in range(16):
            ln = int(beat / 4 * SR * 0.8)
            m = notes[s16 % 4]
            x = np.arange(ln) / SR
            lead = (np.sign(np.sin(2 * np.pi * mid(m) * x)) * 0.5 + np.sin(2 * np.pi * mid(m) * 2 * x) * 0.3) * env(ln, 0.002, 0.08)
            place(lead * 0.07, b0 + s16 * beat / 4)

# simple echo + soft limiter, fades
d = int(beat * 0.75 * SR)
echo = np.zeros(N); echo[d:] = out[:-d] * 0.25
out = out + echo
out *= np.minimum(1, t / 1.5) * np.minimum(1, (DUR - t) / 3)
out = np.tanh(out * 1.3) * 0.85
pcm = (out * 32767).astype(np.int16)
with wave.open("track.wav", "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

# 6 band levels every 33 ms (like the island's meter), normalised
step = int(SR * 0.033); win = 2048
edges = [20, 90, 250, 800, 2500, 6000, 16000]
freqs = np.fft.rfftfreq(win, 1 / SR)
han = np.hanning(win)
frames = []
for i in range(0, N - win, step):
    sp = np.abs(np.fft.rfft(out[i:i + win] * han))
    bands = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = sp[(freqs >= a) & (freqs < b)]
        bands.append(20 * np.log10(m.mean() + 1e-9))
    frames.append(bands)
F = np.array(frames)
lo, hi = np.percentile(F, 10, axis=0), np.percentile(F, 99, axis=0)
F = np.clip((F - lo) / (hi - lo), 0, 1)
json.dump({"step": 0.033, "bands": np.round(F, 3).tolist()}, open("bands.json", "w"))
print("ok", len(frames))
