// Records the promo: the island in the browser, driven by a script, with
// captions, a cursor and a taskbar drawn on top. Frames come from the
// browser's screencast with their timestamps.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'frames');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
const bands = JSON.parse(fs.readFileSync(path.join(__dirname, 'bands.json'), 'utf8'));

const overlay = () => {
  localStorage.setItem('island.tour', 'done');
  localStorage.setItem('island.lang', 'ru');
  localStorage.setItem('island.morning', new Date().toDateString());
  localStorage.setItem('island.night', new Date().toDateString());
  localStorage.setItem('island.pet', JSON.stringify({ stickers: Object.fromEntries(["first", "feed10", "pet25", "play10", "furious", "dizzy5", "fashion", "owl", "lark", "week", "month", "friends", "focus4", "rest", "gamer", "bday"].map((k) => [k, 1])), hearts: 12 }));
  window.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      body { background: radial-gradient(120% 70% at 20% 10%, #3b2a78 0%, transparent 60%), radial-gradient(120% 80% at 90% 90%, #b8456a 0%, transparent 55%), linear-gradient(160deg, #1d1b3a, #5a2a5e 60%, #c0536b) !important; }
      #p-cap { position: fixed; left: 0; right: 0; top: 47%; text-align: center; color: #fff; font: 800 38px/1.12 Inter, system-ui, sans-serif; letter-spacing: -0.5px; padding: 0 30px; z-index: 99998; pointer-events: none; text-shadow: 0 4px 30px rgb(0 0 0 / .45); }
      #p-cap small { display: block; margin-top: 14px; font-weight: 500; font-size: 22px; opacity: .85; letter-spacing: 0; }
      #p-cap.in { animation: capin .55s cubic-bezier(.2,1.2,.3,1) both; }
      #p-cap.out { animation: capout .3s ease-in both; }
      #p-cap.big { font-size: 64px; top: 42%; }
      #p-cap.big small { font-size: 26px; }
      @keyframes capin { from { opacity: 0; transform: translateY(26px) scale(.96); filter: blur(6px); } }
      @keyframes capout { to { opacity: 0; transform: translateY(-14px); filter: blur(4px); } }
      #p-cursor { position: fixed; z-index: 99999; pointer-events: none; width: 26px; height: 26px; left: -50px; top: -50px; transition: transform .08s; filter: drop-shadow(0 2px 3px rgb(0 0 0 / .5)); }
      #p-cursor.down { transform: scale(.85); }
      #p-bar { position: fixed; left: 0; right: 0; bottom: 0; height: 56px; background: rgb(20 20 28 / .72); backdrop-filter: blur(20px); display: flex; align-items: center; justify-content: center; gap: 12px; z-index: 5; }
      #p-bar i { width: 30px; height: 30px; border-radius: 8px; display: block; }
      #p-clock { position: absolute; right: 16px; color: #fff; font: 500 13px Inter, system-ui; text-align: right; opacity: .9; }
    `;
    document.head.appendChild(css);
    const cap = document.createElement('div'); cap.id = 'p-cap'; document.body.appendChild(cap);
    const cur = document.createElement('div'); cur.id = 'p-cursor';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.3-3.4-6.8L4 19.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    const bar = document.createElement('div'); bar.id = 'p-bar';
    bar.innerHTML = ['#4aa3ff', '#ffb347', '#7cd67c', '#c27ce0', '#ff6f9c'].map((c) => `<i style="background:${c}"></i>`).join('') + '<div id="p-clock"></div>';
    document.body.appendChild(bar);
    const tick = () => { const d = new Date(); document.getElementById('p-clock').innerHTML = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '<br>' + d.toLocaleDateString('ru-RU'); };
    tick(); setInterval(tick, 1000);
    window.addEventListener('pointermove', (e) => { cur.style.left = e.clientX - 4 + 'px'; cur.style.top = e.clientY - 2 + 'px'; }, true);
    window.addEventListener('pointerdown', () => cur.classList.add('down'), true);
    window.addEventListener('pointerup', () => cur.classList.remove('down'), true);
    window.cap = (title, sub, big) => {
      cap.className = 'out';
      setTimeout(() => {
        cap.innerHTML = title ? `${title}${sub ? `<small>${sub}</small>` : ''}` : '';
        cap.className = (big ? 'big ' : '') + 'in';
      }, title ? 280 : 0);
    };
    window.startMusic = (b) => {
      window.musicAt = Date.now();
      const t0 = performance.now();
      setInterval(() => {
        const i = Math.floor((performance.now() - t0) / 1000 / b.step);
        const v = b.bands[Math.min(i, b.bands.length - 1)];
        window.__island.emit('audio', v);
      }, 33);
    };
  });
};

(async () => {
  const b = await chromium.launch({ args: ['--force-device-scale-factor=2.25'] });
  const page = await b.newPage({ viewport: { width: 480, height: 853 }, deviceScaleFactor: 2.25 });
  await page.addInitScript(overlay);
  await page.goto('http://localhost:1420/?nomedia&noaudio&pill=lyrics');
  await page.waitForTimeout(2500);
  await page.mouse.move(420, 730);

  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const n = frames.length;
    fs.writeFileSync(path.join(OUT, `f${String(n).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    frames.push(f.metadata.timestamp);
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1 });
  const t0 = Date.now();
  const at = async (sec) => { const w = t0 + sec * 1000 - Date.now(); if (w > 0) await page.waitForTimeout(w); };
  const ev = (name, payload) => page.evaluate(([n, p]) => window.__island.emit(n, p), [name, payload]);
  const card = (c) => page.evaluate((c) => window.dispatchEvent(new CustomEvent('debug-card', { detail: c })), c);
  const glide = async (x, y, steps = 25) => page.mouse.move(x, y, { steps });
  const cap = (a, s, big) => page.evaluate(([a, s, big]) => window.cap(a, s, big), [a, s, !!big]);

  // 1. intro
  await at(0.3); await cap('Dark Island', 'живой остров для Windows', true);
  // 2. music
  await at(3.2);
  await page.evaluate((b) => window.startMusic(b), bands);
  await ev('media', { title: 'Ночной проспект', artist: 'Dark Island', app: 'Spotify.exe', playing: true, cover: null, positionMs: 57_500, durationMs: 213_000, updatedAtMs: Date.now() });
  await page.evaluate(() => { window.__island.state.media = { title: 'Ночной проспект', artist: 'Dark Island', app: 'Spotify.exe', playing: true, cover: null, positionMs: 57_500, durationMs: 213_000, updatedAtMs: Date.now() }; });
  await cap('Музыка оживает', 'свет и эквалайзер в такт');
  await at(8); await cap('Текст песни', 'прямо на острове');
  // 3. hover → home
  await at(12); await cap('Наведи —', 'и всё под рукой');
  await glide(240, 16, 30);
  await at(15.5); await glide(225, 55, 10);
  // 4. tabs
  await at(17); await cap('Погода, буфер, управление', 'в одном движении');
  const tab = async (i) => { const bx = await page.locator('.view.on nav.tabs button').nth(i).boundingBox(); if (bx) { await glide(bx.x + bx.width / 2, bx.y + bx.height / 2, 14); await page.mouse.down(); await page.mouse.up(); } };
  await at(17.6); await tab(4);
  await at(19.4); await tab(1);
  await at(21.2); await tab(6);
  // 5. events
  await at(23.4); await glide(420, 620, 25); await cap('Клодик реагирует', 'на всё, что происходит');
  await at(24.6); await ev('capture', { kind: 'shot', text: 'Снимок экрана 14-32.png', thumb: null, path: 'C:/shot.png' });
  await at(27.2); await ev('downloads', [{ name: 'game-setup.exe', size: 31e6, speed: 8.2e6, total: 96e6 }]);
  await at(28.4); await ev('downloads', [{ name: 'game-setup.exe', size: 74e6, speed: 9.1e6, total: 96e6 }]);
  await at(29.5); await ev('downloads', []); await ev('download_done', { name: 'game-setup.exe', path: 'C:/Downloads/game-setup.exe', size: 96e6 });
  await at(32.2); await card({ kind: 'reminder', title: 'Напоминание', sub: 'созвон с командой', sticky: true, act: 'bell', reminder: { id: 'r', text: 'Созвон с командой', at: Date.now() } });
  await at(33.6); { const bx = await page.locator('.view.on button:has-text("Готово")').boundingBox().catch(() => null); if (bx) { await glide(bx.x + bx.width / 2, bx.y + bx.height / 2, 18); await page.mouse.down(); await page.mouse.up(); } }
  // 6. agents
  await at(35); await cap('ИИ-агенты спрашивают', 'ты отвечаешь с острова');
  await ev('agent', { agent: 'codex', session: 's1', state: 'ask', project: 'dark-island', detail: 'Bash: npm run build', askId: 7, seconds: 30 });
  await at(36.6); { const bx = await page.locator('.view.on button:has-text("Разрешить")').boundingBox().catch(() => null); if (bx) { await glide(bx.x + bx.width / 2, bx.y + bx.height / 2, 20); await page.mouse.down(); await page.mouse.up(); } }
  await at(38); await glide(420, 620, 15);
  // 7. hats: the break scene shows him big, warming up, hats changing
  await at(39); await cap('Твой питомец', 'двадцать нарядов и свой характер');
  await page.evaluate(() => window.dispatchEvent(new Event('debug-break')));
  await at(39.4); await glide(240, 16, 16);
  await at(40.1); await glide(420, 620, 22);
  const hats = ['cowboy', 'viking', 'chef', 'cat', 'halo', 'propeller', 'crown', 'pirate'];
  for (let i = 0; i < hats.length; i++) {
    await at(40.4 + i * 0.6);
    await ev('settings', { buddyHat: hats[i], musicPill: 'lyrics', lyrics: true });
  }
  // 8. outro
  await at(45.4); await glide(420, 680, 18); await page.evaluate(() => document.querySelector('.brk button.text-btn')?.click());
  await cap('Dark Island', 'скоро на Windows', true);
  await at(50.5);

  await cdp.send('Page.stopScreencast');
  const musicAt = await page.evaluate(() => window.musicAt);
  fs.writeFileSync(path.join(__dirname, 'frames.json'), JSON.stringify({ stamps: frames, musicAt }));
  console.log('frames', frames.length, 'span', (frames.at(-1) - frames[0]).toFixed(1), 's');
  await b.close();
})();
