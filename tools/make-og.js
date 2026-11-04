/*
 * 링크 미리보기 그림(og-image.png)과 파비콘(favicon.png/apple-touch-icon.png)을 만든다.
 * 실행: NODE_PATH=<playwright 위치> node tools/make-og.js   (서버 필요 없음)
 * 동물 그림은 art.js의 캐릭터 그리기를 그대로 쓰고, 초원 배경만 여기서 그린다.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent('<body style="margin:0"><canvas id="c" width="1200" height="630"></canvas></body>');
  await page.addScriptTag({ path: path.join(ROOT, 'placement-rules.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'art.js') });
  await page.evaluate(() => {
    const W = 1200; const H = 630; const c = document.getElementById('c'); const g = c.getContext('2d');
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // 하늘
    let gr = g.createLinearGradient(0, 0, 0, 380); gr.addColorStop(0, '#74c6f2'); gr.addColorStop(1, '#eaf9ff');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // 해
    const sun = g.createRadialGradient(990, 120, 10, 990, 120, 190); sun.addColorStop(0, 'rgba(255,248,196,1)'); sun.addColorStop(0.3, 'rgba(255,238,150,0.85)'); sun.addColorStop(1, 'rgba(255,238,150,0)');
    g.fillStyle = sun; g.fillRect(700, 0, 500, 330);
    g.fillStyle = '#ffd95a'; g.beginPath(); g.arc(990, 120, 52, 0, 7); g.fill();
    g.fillStyle = '#fff3a6'; g.beginPath(); g.arc(990, 120, 38, 0, 7); g.fill();
    // 구름
    const cloud = (x, y, s) => { g.fillStyle = 'rgba(255,255,255,0.95)'; [[0, 0, 60, 26], [-46, 8, 40, 20], [48, 8, 44, 20], [-14, -16, 36, 24], [22, -12, 34, 22]].forEach(([dx, dy, rx, ry]) => { g.beginPath(); g.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, 7); g.fill(); }); };
    cloud(190, 110, 1.15); cloud(560, 70, 0.8); cloud(820, 190, 0.7);
    // 먼 언덕
    const hill = (y0, amp, f, ph, c1, c2) => { const gg = g.createLinearGradient(0, y0 - amp, 0, y0 + 160); gg.addColorStop(0, c1); gg.addColorStop(1, c2); g.fillStyle = gg; g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W; x += 10) g.lineTo(x, y0 + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.3 + ph * 1.7) * amp * 0.35); g.lineTo(W, H); g.fill(); };
    hill(330, 26, 0.0052, 0.8, '#b4e093', '#8ccc72');
    // 먼 나무
    const tree = (x, y, s) => { g.fillStyle = '#7a5a3c'; g.fillRect(x - 4 * s, y - 6 * s, 8 * s, 22 * s); [['#5fb25a', 0, -28, 30], ['#74c566', -16, -14, 22], ['#74c566', 16, -14, 22], ['#8bd77a', -6, -36, 18]].forEach(([col, dx, dy, r]) => { g.fillStyle = col; g.beginPath(); g.arc(x + dx * s, y + dy * s, r * s, 0, 7); g.fill(); }); };
    tree(150, 322, 1.0); tree(250, 335, 0.7); tree(1040, 330, 0.9); tree(1130, 343, 0.65);
    hill(375, 22, 0.0065, 2.2, '#9ad97a', '#6fc058');
    // 앞 초원
    gr = g.createLinearGradient(0, 400, 0, H); gr.addColorStop(0, '#8fd868'); gr.addColorStop(1, '#5bb34a');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W; x += 10) g.lineTo(x, 430 + Math.sin(x * 0.0045 + 4) * 14); g.lineTo(W, H); g.fill();
    // 풀과 꽃
    const grass = (x, y, s) => { g.strokeStyle = 'rgba(46,120,52,0.55)'; g.lineWidth = 2.4 * s; g.lineCap = 'round'; [-8, 0, 8].forEach((dx, i) => { g.beginPath(); g.moveTo(x + dx * s, y); g.quadraticCurveTo(x + dx * s * 1.4, y - 12 * s, x + (dx * 1.9 + (i - 1) * 3) * s, y - 20 * s); g.stroke(); }); };
    const flower = (x, y, s, col) => { g.strokeStyle = '#4c9a47'; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 14 * s); g.stroke(); g.fillStyle = col; for (let i = 0; i < 5; i += 1) { const a = (i / 5) * 6.283; g.beginPath(); g.ellipse(x + Math.cos(a) * 5 * s, y + Math.sin(a) * 5 * s, 4.4 * s, 4.4 * s, 0, 0, 7); g.fill(); } g.fillStyle = '#ffcf3d'; g.beginPath(); g.arc(x, y, 3 * s, 0, 7); g.fill(); };
    const spots = []; for (let i = 0; i < 70; i += 1) spots.push([rnd() * W, 440 + rnd() * 190]); spots.sort((a, b) => a[1] - b[1]);
    const cols = ['#ffffff', '#ffd1e0', '#fff0a6', '#ffb4cb', '#ffffff'];
    spots.forEach(([x, y], i) => { const s = 0.7 + (y - 440) / 190 * 0.9; if (i % 3 === 0) grass(x, y, s); else flower(x, y, s, cols[i % cols.length]); });
    // 동물 네 친구: 서로 손(발바닥)을 맞잡도록 이웃 사이에 팔을 이어 그린다
    const Art = window.NatureArt; const sc = 5; const gapL = 54; const gap = gapL * sc; const feetY = 604; const order = [0xf27b6a, 0x7146c4, 0xf4b942, 0x2987c5];
    const start = W / 2 - gap * 1.5; const pawColor = { 0xf27b6a: '#bfa78c', 0x7146c4: '#b98458', 0xf4b942: '#f6e8cb', 0x2987c5: '#34353c' };
    const sprites = order.map((color, i) => ({ color, cv: Art.makeCharacter(color, 'f', null, sc), x: start + gap * i - 36 * sc, y: feetY - 91 * sc + (i % 2 ? -10 : 0) }));
    sprites.forEach((s) => g.drawImage(s.cv, s.x, s.y));
    const pawR = 4.4 * sc; const OUT = 'rgba(60,40,30,0.55)';
    const paw = (x, y, col) => { g.fillStyle = col; g.strokeStyle = OUT; g.lineWidth = 1.5 * sc * 0.5 + 1; g.beginPath(); g.arc(x, y, pawR, 0, 7); g.fill(); g.stroke(); };
    for (let i = 0; i < sprites.length - 1; i += 1) {
      const a = sprites[i]; const b = sprites[i + 1];
      const ax = a.x + 57.5 * sc; const ay = a.y + 71 * sc; const bx = b.x + 14.5 * sc; const by = b.y + 71 * sc;
      // 손 사이 연결(둘이 맞잡은 모습)
      const lg = g.createLinearGradient(ax, ay, bx, by); lg.addColorStop(0, pawColor[a.color]); lg.addColorStop(1, pawColor[b.color]);
      g.lineCap = 'round'; g.strokeStyle = OUT; g.lineWidth = pawR * 1.5 + 3; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.strokeStyle = lg; g.lineWidth = pawR * 1.5; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      paw(ax, ay, pawColor[a.color]); paw(bx, by, pawColor[b.color]);
      // 맞잡은 손 가운데 작은 하트
      g.fillStyle = '#ff7f9c'; const hx = (ax + bx) / 2; const hy = (ay + by) / 2 - pawR * 1.5; g.beginPath(); g.moveTo(hx, hy + 9); g.bezierCurveTo(hx - 16, hy - 4, hx - 6, hy - 14, hx, hy - 5); g.bezierCurveTo(hx + 6, hy - 14, hx + 16, hy - 4, hx, hy + 9); g.fill();
    }
    // 나비와 반짝이
    const butterfly = (x, y, s, col) => { g.save(); g.translate(x, y); g.rotate(-0.3); g.fillStyle = col; [[-9, -4], [9, -4], [-7, 6], [7, 6]].forEach(([dx, dy], i) => { g.beginPath(); g.ellipse(dx * s, dy * s, (i < 2 ? 10 : 7) * s, (i < 2 ? 8 : 6) * s, dx < 0 ? -0.5 : 0.5, 0, 7); g.fill(); }); g.fillStyle = '#5a3a30'; g.fillRect(-1.5 * s, -8 * s, 3 * s, 18 * s); g.restore(); };
    butterfly(150, 300, 1.7, '#ff9fc0'); butterfly(1060, 250, 1.4, '#ffd24d');
    g.fillStyle = 'rgba(255,255,255,0.9)'; [[300, 160, 6], [880, 70, 5], [720, 240, 4]].forEach(([x, y, r]) => { g.beginPath(); g.moveTo(x, y - r * 2); g.quadraticCurveTo(x, y, x + r * 2, y); g.quadraticCurveTo(x, y, x, y + r * 2); g.quadraticCurveTo(x, y, x - r * 2, y); g.quadraticCurveTo(x, y, x, y - r * 2); g.fill(); });
  });
  await (await page.$('#c')).screenshot({ path: path.join(ROOT, 'og-image.png') });

  // 파비콘: 초원 그림(favicon.svg)을 PNG로도 만들어 둔다(옛 브라우저·홈 화면 추가용)
  const svg = fs.readFileSync(path.join(__dirname, 'favicon.svg'), 'utf8');
  for (const [size, name] of [[32, 'favicon-32.png'], [180, 'apple-touch-icon.png']]) {
    const p2 = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p2.setContent(`<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body>`);
    await p2.screenshot({ path: path.join(ROOT, name), omitBackground: true });
    await p2.close();
  }
  fs.copyFileSync(path.join(__dirname, 'favicon.svg'), path.join(ROOT, 'favicon.svg'));
  await browser.close();
})();
