/*
 * 그림 만들기. 그림 파일(SVG)을 따로 두지 않고, 브라우저가 시작할 때 캔버스로 직접 그립니다.
 *   - 같은 숫자(시드)로 그리므로 모든 학생 화면의 풍경이 똑같습니다.
 *   - 빛은 항상 왼쪽 위에서 오고, 그림자는 오른쪽 아래로 떨어집니다.
 * 결과는 Phaser 텍스처로 등록됩니다: ground(바닥 전체), tree1~3, shrubFlower, wildflowerPatch, mossyRocks,
 * fallenBranch, grassTuft, lilyReeds, bench, char_<색>.
 */
(function (root, factory) {
  root.NatureArt = factory(root.NatureRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const TAU = Math.PI * 2;
  const W = R.WORLD_WIDTH;
  const H = R.WORLD_HEIGHT;

  // ---------- 바탕 도구 ----------
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeNoise(seed) {
    const r = rng(seed); const size = 256; const grid = new Float32Array(size * size);
    for (let i = 0; i < grid.length; i += 1) grid[i] = r();
    const at = (x, y) => grid[((y & 255) << 8) | (x & 255)];
    const fade = (t) => t * t * (3 - 2 * t);
    return function (x, y) {
      const xi = Math.floor(x); const yi = Math.floor(y); const fx = fade(x - xi); const fy = fade(y - yi);
      const a = at(xi, yi); const b = at(xi + 1, yi); const c = at(xi, yi + 1); const d = at(xi + 1, yi + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
  }
  function fbm(noise, x, y, octaves) {
    let sum = 0; let amp = 0.5; let total = 0; let f = 1;
    for (let i = 0; i < octaves; i += 1) { sum += noise(x * f, y * f) * amp; total += amp; amp *= 0.5; f *= 2; }
    return sum / total;
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  function hex(color) { return [(color >> 16) & 255, (color >> 8) & 255, color & 255]; }
  function mix(c1, c2, t) { const a = hex(c1); const b = hex(c2); return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  const rgba = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  // 빛이 왼쪽 위에서 오는 둥근 덩어리(잎 뭉치, 덤불 등)
  function blob(g, x, y, r, light, mid, dark) {
    const grad = g.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.08, x, y, r * 1.02);
    grad.addColorStop(0, light); grad.addColorStop(0.5, mid); grad.addColorStop(1, dark);
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  // 땅에 닿는 부드러운 그림자(오른쪽 아래로 살짝 치우침)
  function groundShadow(g, cx, cy, rx, ry, alpha) {
    g.save(); g.translate(cx, cy); g.scale(1, ry / rx);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(28,52,36,${alpha})`); grad.addColorStop(0.6, `rgba(28,52,36,${alpha * 0.55})`); grad.addColorStop(1, 'rgba(28,52,36,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(0, 0, rx, 0, TAU); g.fill(); g.restore();
  }
  function leaf(g, x, y, len, angle, color, alpha = 1) {
    g.save(); g.translate(x, y); g.rotate(angle); g.globalAlpha = alpha; g.fillStyle = color;
    g.beginPath(); g.ellipse(0, 0, len, len * 0.42, 0, 0, TAU); g.fill(); g.restore();
  }
  function blade(g, x, y, h, bend, w, color) {
    g.strokeStyle = color; g.lineWidth = w; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + bend * 0.3, y - h * 0.55, x + bend, y - h); g.stroke();
  }

  // ---------- 바닥 ----------
  function wobblyRoundedRect(area, radius, seed, amount) {
    const n = makeNoise(seed); const pts = []; const step = 14; const r = Math.min(radius, area.width / 2, area.height / 2);
    const corner = (cx, cy, a0, a1) => { const k = Math.max(4, Math.round((r * Math.abs(a1 - a0)) / step)); for (let i = 0; i <= k; i += 1) { const a = lerp(a0, a1, i / k); pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
    const edge = (x0, y0, x1, y1) => { const len = Math.hypot(x1 - x0, y1 - y0); const k = Math.max(1, Math.round(len / step)); for (let i = 1; i < k; i += 1) pts.push([lerp(x0, x1, i / k), lerp(y0, y1, i / k)]); };
    const x0 = area.x; const y0 = area.y; const x1 = area.x + area.width; const y1 = area.y + area.height;
    corner(x0 + r, y0 + r, Math.PI, Math.PI * 1.5); edge(x0 + r, y0, x1 - r, y0);
    corner(x1 - r, y0 + r, Math.PI * 1.5, TAU); edge(x1, y0 + r, x1, y1 - r);
    corner(x1 - r, y1 - r, 0, Math.PI * 0.5); edge(x1 - r, y1, x0 + r, y1);
    corner(x0 + r, y1 - r, Math.PI * 0.5, Math.PI); edge(x0, y1 - r, x0, y0 + r);
    const cx = area.x + area.width / 2; const cy = area.y + area.height / 2;
    return pts.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1; const w = (n(x / 70, y / 70) - 0.5) * 2 * amount;
      // 물 가장자리는 직사각형 안쪽으로만 흔들어서, 놓기 규칙의 물 영역과 어긋나지 않게 한다.
      const inward = Math.abs(w);
      return [x + ((cx - x) / d) * inward, y + ((cy - y) / d) * inward];
    });
  }
  function polyPath(g, pts) { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }

  function paintGround() {
    const [cv, g] = canvas(W, H);
    const rand = rng(7);
    const nA = makeNoise(11); const nB = makeNoise(29); const nC = makeNoise(53);

    // 1) 색 바탕: 큰 얼룩 + 작은 얼룩 + 구역별 색
    const lw = 600; const lh = 375; const [lc, lg] = canvas(lw, lh); const img = lg.createImageData(lw, lh);
    const deep = 0x4fa24c; const midc = 0x7ccb58; const light = 0xb4e66c; const sun = 0xd5f08a;
    const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
    for (let y = 0; y < lh; y += 1) {
      for (let x = 0; x < lw; x += 1) {
        const wx = x * 4; const wy = y * 4;
        const big = fbm(nA, wx / 340, wy / 340, 3); const small = fbm(nB, wx / 70, wy / 70, 2);
        let t = clamp01(big * 1.25 - 0.12 + (small - 0.5) * 0.35);
        let col = t < 0.5 ? mix(deep, midc, t / 0.5) : mix(midc, light, (t - 0.5) / 0.5);
        const meadow = 1 - smooth(0.55, 1, Math.hypot((wx - 740) / 760, (wy - 560) / 560));
        if (meadow > 0) { const s = mix(0x7ccb58, sun, 0.6); col = [lerp(col[0], s[0], meadow * 0.38), lerp(col[1], s[1], meadow * 0.38), lerp(col[2], s[2], meadow * 0.38)]; }
        const field = (1 - smooth(0.35, 1, Math.max(Math.abs(wx - 1030) / 700, Math.abs(wy - 1235) / 240)));
        if (field > 0) { const s = mix(0xb4e66c, 0xe6e88a, 0.55); col = [lerp(col[0], s[0], field * 0.4), lerp(col[1], s[1], field * 0.4), lerp(col[2], s[2], field * 0.4)]; }
        const quiet = 1 - smooth(0.2, 1, Math.hypot(wx - 300, wy - 1160) / 210);
        if (quiet > 0) { const s = mix(0x3f9a56, 0x2d7f4d, 0.5); col = [lerp(col[0], s[0], quiet * 0.62), lerp(col[1], s[1], quiet * 0.62), lerp(col[2], s[2], quiet * 0.62)]; }
        const wet = 1 - smooth(0.3, 1, Math.hypot((wx - 2005) / 290, (wy - 1030) / 260));
        if (wet > 0) { const s = mix(0x6cc08a, 0x4ea87a, 0.5); col = [lerp(col[0], s[0], wet * 0.5), lerp(col[1], s[1], wet * 0.5), lerp(col[2], s[2], wet * 0.5)]; }
        const edge = Math.min(wx, W - wx, wy, H - wy); const vignette = 1 - smooth(0, 230, edge);
        const shade = 1 - vignette * 0.34; const o = (y * lw + x) * 4;
        img.data[o] = col[0] * shade * (1 - vignette * 0.1); img.data[o + 1] = col[1] * shade; img.data[o + 2] = col[2] * shade * (1 + vignette * 0.12); img.data[o + 3] = 255;
      }
    }
    lg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(lc, 0, 0, W, H);

    // 2) 흙길 (규칙의 길 모양 그대로)
    const pathPoly = R.pathPolygon(0);
    drawDirtPath(g, pathPoly, rand);
    const fp = R.FIELD_PATH;
    drawDirtPath(g, wobblyRoundedRect({ x: fp.x, y: fp.y, width: fp.width, height: fp.height }, 21, 71, 3), rand);

    // 3) 물, 섬, 습지
    paintWater(g, rand);

    // 4) 풀잎 결 (물 위에는 그리지 않음: 물을 먼저 그렸으니 땅 위에서만)
    paintGrassTexture(g, rand, nC);

    // 5) 잔 꽃, 클로버, 조약돌
    paintGroundDetails(g, rand);

    // 6) 가장자리 울타리(덤불 띠). 걸어 다닐 수 없는 바깥 가장자리 부분
    paintEdgeHedge(g);
    return cv;
  }

  function drawDirtPath(g, pts, rand) {
    // 길 가장자리: 풀이 눌려 어두워진 띠 → 마른 흙 → 가운데 밝은 흙
    g.save(); g.lineJoin = 'round';
    polyPath(g, pts);
    g.shadowColor = 'rgba(70,62,30,0.45)'; g.shadowBlur = 22; g.fillStyle = '#9a8453'; g.fill();
    g.shadowColor = 'transparent'; g.shadowBlur = 0;
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const grad = g.createLinearGradient(0, minY, 0, maxY);
    grad.addColorStop(0, '#cfae74'); grad.addColorStop(0.5, '#e2c68e'); grad.addColorStop(1, '#c4a068');
    polyPath(g, pts); g.fillStyle = grad; g.fill();
    g.save(); polyPath(g, pts); g.clip();
    // 바퀴자국 같은 얇은 결과 흙 알갱이
    for (let i = 0; i < Math.round((maxX - minX) * (maxY - minY) / 260); i += 1) {
      const x = minX + rand() * (maxX - minX); const y = minY + rand() * (maxY - minY);
      const s = 0.8 + rand() * 2.2; g.fillStyle = rand() < 0.5 ? 'rgba(120,90,50,0.28)' : 'rgba(255,244,205,0.4)';
      g.beginPath(); g.ellipse(x, y, s * 1.4, s, rand() * 3, 0, TAU); g.fill();
    }
    g.strokeStyle = 'rgba(122,92,52,0.5)'; g.lineWidth = 3; polyPath(g, pts); g.stroke();
    g.restore();
    // 가장자리로 삐져나온 풀
    for (let i = 0; i < pts.length * 2; i += 1) {
      const p = pts[Math.floor(rand() * pts.length)]; const x = p[0] + (rand() - 0.5) * 8; const y = p[1] + (rand() - 0.5) * 6;
      for (let k = 0; k < 3; k += 1) blade(g, x + k * 3, y + 2, 9 + rand() * 7, (rand() - 0.5) * 6, 1.6, rand() < 0.5 ? '#4f9e48' : '#7fc65a');
    }
    g.restore();
  }

  function paintWater(g, rand) {
    const areas = R.WATER_AREAS;
    const shapes = areas.map((a, i) => wobblyRoundedRect(a, i === 0 ? 170 : 60, 91 + i * 13, 9));
    // 물가: 어두운 젖은 흙 → 밝은 모래
    g.save(); g.lineJoin = 'round';
    shapes.forEach((pts) => { polyPath(g, pts); g.shadowColor = 'rgba(52,70,40,0.5)'; g.shadowBlur = 26; g.strokeStyle = '#7d8a4a'; g.lineWidth = 46; g.stroke(); });
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    shapes.forEach((pts) => { polyPath(g, pts); g.strokeStyle = '#d9cc8f'; g.lineWidth = 34; g.stroke(); polyPath(g, pts); g.strokeStyle = '#efe3ad'; g.lineWidth = 20; g.stroke(); });
    g.restore();

    // 물 깊이: 가장자리는 옅은 청록, 안쪽은 진한 파랑. 합친 모양을 흐리게 만들어 칠한다.
    const sw = 400; const sh = 250; const [mc, mg] = canvas(sw, sh);
    mg.fillStyle = '#fff'; areas.forEach((a) => mg.fillRect(a.x / 6, a.y / 6, a.width / 6, a.height / 6));
    const m = mg.getImageData(0, 0, sw, sh).data; let field = new Float32Array(sw * sh);
    for (let i = 0; i < field.length; i += 1) field[i] = m[i * 4] / 255;
    for (let pass = 0; pass < 3; pass += 1) {
      const tmp = new Float32Array(sw * sh); const rad = 7;
      for (let y = 0; y < sh; y += 1) for (let x = 0; x < sw; x += 1) { let s = 0; for (let k = -rad; k <= rad; k += 1) s += field[y * sw + Math.min(sw - 1, Math.max(0, x + k))]; tmp[y * sw + x] = s / (2 * rad + 1); }
      for (let y = 0; y < sh; y += 1) for (let x = 0; x < sw; x += 1) { let s = 0; for (let k = -rad; k <= rad; k += 1) s += tmp[Math.min(sh - 1, Math.max(0, y + k)) * sw + x]; field[y * sw + x] = s / (2 * rad + 1); }
    }
    const [dc, dg] = canvas(sw, sh); const dimg = dg.createImageData(sw, sh);
    const nW = makeNoise(77);
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const depth = clamp01((field[y * sw + x] - 0.28) / 0.55) + (fbm(nW, x / 22, y / 22, 2) - 0.5) * 0.18;
        const t = clamp01(depth);
        const c = t < 0.5 ? mix(0xa8f0dc, 0x56cfd8, t / 0.5) : mix(0x56cfd8, 0x2a9cc6, (t - 0.5) / 0.5);
        const o = (y * sw + x) * 4; dimg.data[o] = c[0]; dimg.data[o + 1] = c[1]; dimg.data[o + 2] = c[2]; dimg.data[o + 3] = 255;
      }
    }
    dg.putImageData(dimg, 0, 0);
    g.save(); g.beginPath(); shapes.forEach((pts) => pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))));
    // 각 도형을 따로 닫아 합친 영역으로 쓴다
    g.beginPath(); shapes.forEach((pts) => { pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); });
    g.clip('nonzero'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(dc, 0, 0, W, H);
    // 빛무늬(카우스틱)와 반짝임
    for (let i = 0; i < 520; i += 1) {
      const a = areas[rand() < 0.7 ? 0 : (rand() < 0.5 ? 1 : 2)]; const x = a.x + rand() * a.width; const y = a.y + rand() * a.height;
      g.strokeStyle = `rgba(235,255,250,${0.1 + rand() * 0.16})`; g.lineWidth = 1.5 + rand() * 1.5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + 10, y - 5, x + 22, y + 5, x + 34 + rand() * 14, y); g.stroke();
    }
    for (let i = 0; i < 110; i += 1) { const a = areas[0]; const x = a.x + rand() * a.width; const y = a.y + rand() * a.height; g.fillStyle = `rgba(255,255,255,${0.3 + rand() * 0.4})`; g.beginPath(); g.arc(x, y, 1 + rand() * 1.8, 0, TAU); g.fill(); }
    // 연잎과 연꽃
    const lilies = [[1400, 640], [1470, 700], [1860, 330], [1930, 420], [1350, 520], [1790, 760], [1500, 300], [1960, 690], [1420, 420], [1700, 640], [1240, 810]];
    lilies.forEach(([x, y], i) => { if (!R.isWater({ x, y })) return; drawLilyPad(g, x, y, 24 + (i % 3) * 5, i, rand); });
    g.restore();

    // 섬
    const I = R.ISLAND;
    g.save();
    g.shadowColor = 'rgba(40,80,70,0.5)'; g.shadowBlur = 22; g.fillStyle = '#b8a66a'; g.beginPath(); g.ellipse(I.cx, I.cy + 4, I.rx + 8, I.ry + 8, 0, 0, TAU); g.fill();
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    const sg = g.createRadialGradient(I.cx - 30, I.cy - 22, 10, I.cx, I.cy, I.rx); sg.addColorStop(0, '#f5e8b8'); sg.addColorStop(1, '#d8c487');
    g.fillStyle = sg; g.beginPath(); g.ellipse(I.cx, I.cy, I.rx, I.ry, 0, 0, TAU); g.fill();
    const gg = g.createRadialGradient(I.cx - 28, I.cy - 26, 6, I.cx, I.cy - 4, I.rx * 0.82); gg.addColorStop(0, '#c9ee80'); gg.addColorStop(0.6, '#8fd062'); gg.addColorStop(1, '#5fae4f');
    g.fillStyle = gg; g.beginPath(); g.ellipse(I.cx, I.cy - 4, I.rx * 0.82, I.ry * 0.78, 0, 0, TAU); g.fill();
    for (let i = 0; i < 70; i += 1) { const a = rand() * TAU; const rr = Math.sqrt(rand()); const x = I.cx + Math.cos(a) * rr * I.rx * 0.74; const y = I.cy - 4 + Math.sin(a) * rr * I.ry * 0.7; blade(g, x, y, 8 + rand() * 8, (rand() - 0.5) * 5, 1.6, rand() < 0.5 ? '#4a9a47' : '#a8dd6a'); }
    g.restore();

    // 갈대밭의 얕은 물웅덩이
    const sh1 = R.SHALLOWS[0]; const sp = wobblyRoundedRect(sh1, 54, 131, 8);
    g.save(); g.lineJoin = 'round'; polyPath(g, sp); g.shadowColor = 'rgba(50,70,40,0.45)'; g.shadowBlur = 20; g.strokeStyle = '#7e8f55'; g.lineWidth = 34; g.stroke();
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    const pg = g.createLinearGradient(0, sh1.y, 0, sh1.y + sh1.height); pg.addColorStop(0, '#8cdcc0'); pg.addColorStop(1, '#4faac0');
    polyPath(g, sp); g.fillStyle = pg; g.fill(); g.clip();
    for (let i = 0; i < 40; i += 1) { const x = sh1.x + rand() * sh1.width; const y = sh1.y + rand() * sh1.height; g.strokeStyle = 'rgba(240,255,250,0.3)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20 + rand() * 18, y); g.stroke(); }
    g.restore();
  }
  function drawLilyPad(g, x, y, r, i, rand) {
    g.save(); g.translate(x, y); g.rotate(rand() * TAU); g.scale(1, 0.62);
    g.fillStyle = 'rgba(20,60,70,0.28)'; g.beginPath(); g.ellipse(4, 6, r, r, 0, 0, TAU); g.fill();
    const lg = g.createRadialGradient(-r * 0.3, -r * 0.3, 2, 0, 0, r); lg.addColorStop(0, '#9ee26a'); lg.addColorStop(1, '#3f9f4f');
    g.fillStyle = lg; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, 0.35, TAU - 0.1); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(30,100,50,0.5)'; g.lineWidth = 1.5; g.stroke();
    g.restore();
    if (i % 3 === 0) {
      for (let k = 0; k < 6; k += 1) { const a = (k / 6) * TAU; g.fillStyle = k % 2 ? '#ffd6e4' : '#ffb8d2'; g.beginPath(); g.ellipse(x + Math.cos(a) * 7, y - 3 + Math.sin(a) * 4, 7, 3.4, a, 0, TAU); g.fill(); }
      g.fillStyle = '#ffd95a'; g.beginPath(); g.arc(x, y - 3, 3, 0, TAU); g.fill();
    }
  }

  function paintGrassTexture(g, rand, noise) {
    const count = 26000;
    for (let i = 0; i < count; i += 1) {
      const x = rand() * W; const y = rand() * H;
      if (R.isWater({ x, y }) || (x > 1560 && x < 1740 && y > 760 && y < 1210)) continue;
      if (R.ISLAND && ((x - R.ISLAND.cx) / (R.ISLAND.rx + 20)) ** 2 + ((y - R.ISLAND.cy) / (R.ISLAND.ry + 20)) ** 2 < 1) continue;
      const bright = noise(x / 140, y / 140); const h = 7 + rand() * 9;
      const c = bright > 0.52 ? mix(0x8fd35a, 0xd6f58a, rand()) : mix(0x3d9548, 0x69b955, rand());
      g.globalAlpha = 0.28 + rand() * 0.3;
      blade(g, x, y, h, (rand() - 0.5) * 7, 1.3 + rand() * 0.8, rgba(c));
    }
    g.globalAlpha = 1;
  }

  function paintGroundDetails(g, rand) {
    const petals = ['#ffffff', '#ffe27a', '#ff9db4', '#c7a2f2', '#ffb870'];
    let placed = 0; let tries = 0;
    while (placed < 260 && tries < 4000) {
      tries += 1; const x = 60 + rand() * (W - 120); const y = 90 + rand() * (H - 150);
      if (R.groundBlock('wildflower', x, y)) continue;
      placed += 1; const c = petals[Math.floor(rand() * petals.length)]; const s = 2.2 + rand() * 2;
      g.strokeStyle = 'rgba(52,130,64,0.8)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(x, y + 6); g.lineTo(x, y); g.stroke();
      g.fillStyle = c; for (let k = 0; k < 5; k += 1) { const a = (k / 5) * TAU; g.beginPath(); g.arc(x + Math.cos(a) * s, y + Math.sin(a) * s, s * 0.75, 0, TAU); g.fill(); }
      g.fillStyle = c === '#ffe27a' ? '#e8a020' : '#ffd24a'; g.beginPath(); g.arc(x, y, s * 0.55, 0, TAU); g.fill();
    }
    placed = 0; tries = 0;
    while (placed < 150 && tries < 4000) {
      tries += 1; const x = 60 + rand() * (W - 120); const y = 90 + rand() * (H - 150);
      if (R.groundBlock('wildflower', x, y) === 'water' || R.groundBlock('wildflower', x, y) === 'bounds') continue;
      placed += 1; const s = 1.5 + rand() * 3;
      if (rand() < 0.5) { g.fillStyle = 'rgba(80,70,60,0.28)'; g.beginPath(); g.ellipse(x + 1, y + s * 0.6, s * 1.3, s * 0.6, 0, 0, TAU); g.fill(); g.fillStyle = rand() < 0.5 ? '#b9b6ab' : '#cfc9b8'; g.beginPath(); g.ellipse(x, y, s * 1.2, s * 0.8, 0, 0, TAU); g.fill(); }
      else { g.fillStyle = 'rgba(60,140,70,0.75)'; for (let k = 0; k < 3; k += 1) { g.beginPath(); g.arc(x + Math.cos(k * 2.1) * 3, y + Math.sin(k * 2.1) * 2.4, 2.8, 0, TAU); g.fill(); } }
    }
  }

  function paintEdgeHedge(g) {
    const rand = rng(404); const pal = [['#7fc15a', '#3f8a46', '#245c38'], ['#6cb552', '#38803f', '#1f5233'], ['#8ccc5f', '#46934a', '#2a6a3c']];
    const put = (x, y, r) => { const p = pal[Math.floor(rand() * 3)]; blob(g, x, y, r, p[0], p[1], p[2]); };
    for (let x = -20; x < W + 30; x += 34) { put(x + rand() * 14, 6 + rand() * 18, 34 + rand() * 18); put(x + rand() * 14, H - 4 - rand() * 14, 34 + rand() * 18); }
    for (let y = 0; y < H + 30; y += 34) { put(2 + rand() * 12, y + rand() * 14, 30 + rand() * 16); put(W - 2 - rand() * 12, y + rand() * 14, 30 + rand() * 16); }
  }

  // ---------- 나무와 식물 ----------
  const TREE_PALETTES = [
    { l: '#c8ee78', m: '#63bb50', d: '#2c7a42', t: '#d9f593' },
    { l: '#d3ef7b', m: '#79c254', d: '#38873f', t: '#ecf8a2' },
    { l: '#a9e07a', m: '#4aa95a', d: '#256e48', t: '#c9f09b' }
  ];
  function makeTree(seed, pal) {
    const [cv, g] = canvas(340, 400); const rand = rng(seed); const bx = 170; const by = 352;
    groundShadow(g, bx + 26, by + 6, 118, 118 * 0.2, 0.42);
    // 줄기: 아래가 넓게 퍼지는 뿌리, 왼쪽이 밝다
    const tg = g.createLinearGradient(bx - 24, 0, bx + 24, 0); tg.addColorStop(0, '#a77a4e'); tg.addColorStop(0.45, '#7a5434'); tg.addColorStop(1, '#4a3022');
    g.fillStyle = tg; g.beginPath(); g.moveTo(bx - 34, by + 4); g.bezierCurveTo(bx - 16, by - 6, bx - 14, by - 60, bx - 13, by - 120); g.lineTo(bx + 13, by - 120); g.bezierCurveTo(bx + 14, by - 60, bx + 16, by - 6, bx + 36, by + 4);
    g.bezierCurveTo(bx + 14, by + 10, bx - 14, by + 10, bx - 34, by + 4); g.fill();
    g.strokeStyle = 'rgba(40,24,16,0.5)'; g.lineWidth = 2; for (let i = 0; i < 9; i += 1) { const x = bx - 12 + rand() * 24; g.beginPath(); g.moveTo(x, by - rand() * 20); g.quadraticCurveTo(x + (rand() - 0.5) * 6, by - 60, x + (rand() - 0.5) * 4, by - 70 - rand() * 50); g.stroke(); }
    g.strokeStyle = 'rgba(255,225,170,0.35)'; g.lineWidth = 3; g.beginPath(); g.moveTo(bx - 10, by - 4); g.quadraticCurveTo(bx - 8, by - 60, bx - 7, by - 112); g.stroke();
    g.strokeStyle = '#6b4a30'; g.lineWidth = 11; g.lineCap = 'round'; [[-1, -1], [1, -1]].forEach(([sx]) => { g.beginPath(); g.moveTo(bx + sx * 4, by - 100); g.quadraticCurveTo(bx + sx * 32, by - 140, bx + sx * 56, by - 168); g.stroke(); });
    // 수관: 아래층(어두움) → 가운데 → 위층(밝음)
    const cx = bx; const cy = 178; const spots = [];
    for (let i = 0; i < 54; i += 1) { const a = rand() * TAU; const rr = Math.sqrt(rand()); spots.push({ x: cx + Math.cos(a) * rr * 104, y: cy + Math.sin(a) * rr * 84 + 6, r: 30 + rand() * 24 }); }
    spots.sort((a, b) => b.y - a.y);
    spots.forEach((s) => blob(g, s.x + 6, s.y + 8, s.r, pal.d, pal.d, '#1f5a36'));
    spots.forEach((s) => blob(g, s.x, s.y, s.r, pal.m, pal.m, pal.d));
    spots.filter((s) => s.y < cy + 20).forEach((s) => blob(g, s.x - 4, s.y - 6, s.r * 0.78, pal.l, pal.m, pal.m));
    for (let i = 0; i < 28; i += 1) { const a = rand() * TAU; const rr = 0.35 + rand() * 0.55; const x = cx - 24 + Math.cos(a) * rr * 80; const y = cy - 26 + Math.sin(a) * rr * 60; if (x + y > cx + cy + 20) continue; blob(g, x, y, 14 + rand() * 12, pal.t, pal.l, pal.m); }
    // 잎 결
    for (let i = 0; i < 420; i += 1) { const a = rand() * TAU; const rr = Math.sqrt(rand()); const x = cx + Math.cos(a) * rr * 112; const y = cy + Math.sin(a) * rr * 92 + 6; const lit = (x - cx) * 0.7 + (y - cy) * 0.7 < 0; leaf(g, x, y, 4 + rand() * 4, rand() * TAU, lit ? pal.t : pal.d, lit ? 0.5 : 0.4); }
    // 빛 비치는 가장자리
    g.strokeStyle = 'rgba(255,255,200,0.18)'; g.lineWidth = 5; g.beginPath(); g.arc(cx - 6, cy - 6, 98, Math.PI * 1.05, Math.PI * 1.6); g.stroke();
    return cv;
  }

  function makeShrub() {
    const [cv, g] = canvas(300, 240); const rand = rng(31); const cx = 150; const base = 206;
    groundShadow(g, cx + 16, base + 4, 116, 116 * 0.2, 0.4);
    const spots = [];
    for (let i = 0; i < 26; i += 1) { const a = Math.PI + rand() * Math.PI; const rr = 0.2 + rand() * 0.8; spots.push({ x: cx + Math.cos(a) * rr * 108, y: base - 24 + Math.sin(a) * rr * 66 + rand() * 26, r: 26 + rand() * 18 }); }
    for (let i = 0; i < 8; i += 1) spots.push({ x: cx - 70 + i * 20, y: base - 14 + rand() * 8, r: 24 + rand() * 8 });
    spots.sort((a, b) => a.y - b.y);
    spots.forEach((s) => blob(g, s.x + 4, s.y + 6, s.r, '#2c7a42', '#2c7a42', '#1d5535'));
    spots.forEach((s) => blob(g, s.x, s.y, s.r, '#a8e06c', '#56b050', '#2f7e43'));
    for (let i = 0; i < 160; i += 1) { const s = spots[Math.floor(rand() * spots.length)]; const a = rand() * TAU; leaf(g, s.x + Math.cos(a) * s.r * 0.8, s.y + Math.sin(a) * s.r * 0.8, 4 + rand() * 3, a, rand() < 0.5 ? '#c6ee86' : '#2d7a40', 0.55); }
    // 꽃
    const colors = [['#ffd1e0', '#ff8fb4'], ['#fff3f7', '#ffb7ce'], ['#ffe08a', '#ffbf3a']];
    for (let i = 0; i < 48; i += 1) {
      const s = spots[Math.floor(rand() * spots.length)]; const a = rand() * TAU; const x = s.x + Math.cos(a) * s.r * 0.65; const y = s.y + Math.sin(a) * s.r * 0.55 - 4;
      const c = colors[i % 3]; const pr = 4.2 + rand() * 2.6;
      g.fillStyle = c[1]; for (let k = 0; k < 5; k += 1) { const t = (k / 5) * TAU + a; g.beginPath(); g.arc(x + Math.cos(t) * pr * 0.9, y + Math.sin(t) * pr * 0.9, pr * 0.72, 0, TAU); g.fill(); }
      g.fillStyle = c[0]; for (let k = 0; k < 5; k += 1) { const t = (k / 5) * TAU + a; g.beginPath(); g.arc(x + Math.cos(t) * pr * 0.8 - 0.7, y + Math.sin(t) * pr * 0.8 - 0.7, pr * 0.52, 0, TAU); g.fill(); }
      g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(x, y, pr * 0.42, 0, TAU); g.fill();
    }
    return cv;
  }

  function makeWildflowers() {
    const [cv, g] = canvas(260, 200); const rand = rng(57); const base = 172;
    groundShadow(g, 140, base + 4, 100, 100 * 0.18, 0.3);
    for (let i = 0; i < 70; i += 1) { const x = 40 + rand() * 180; blade(g, x, base - rand() * 8, 28 + rand() * 38, (rand() - 0.5) * 26, 2.4, rand() < 0.5 ? '#3d9548' : '#6cbf58'); }
    const kinds = [
      { p: '#ffffff', c: '#ffcf3a', n: 9 }, { p: '#ffd0e0', c: '#ff9f2e', n: 8 }, { p: '#c9a6f4', c: '#ffe26a', n: 10 }, { p: '#ffe36a', c: '#c97b1e', n: 8 }, { p: '#ff9db4', c: '#ffe26a', n: 7 }
    ];
    const stems = [];
    for (let i = 0; i < 26; i += 1) stems.push({ x: 40 + rand() * 180, h: 44 + rand() * 74, k: kinds[i % kinds.length], bend: (rand() - 0.5) * 22 });
    stems.sort((a, b) => b.h - a.h);
    stems.forEach((s) => {
      const top = { x: s.x + s.bend, y: base - s.h };
      g.strokeStyle = '#3f9a4c'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(s.x, base); g.quadraticCurveTo(s.x + s.bend * 0.2, base - s.h * 0.55, top.x, top.y); g.stroke();
      leaf(g, s.x + s.bend * 0.3, base - s.h * 0.4, 9, -0.7, '#5fb556', 0.95);
      const r = 8 + (s.k.n > 8 ? 1.5 : 0);
      for (let k = 0; k < s.k.n; k += 1) { const t = (k / s.k.n) * TAU; g.save(); g.translate(top.x, top.y); g.rotate(t); g.fillStyle = s.k.p; g.beginPath(); g.ellipse(r * 0.75, 0, r * 0.7, r * 0.32, 0, 0, TAU); g.fill(); g.strokeStyle = 'rgba(120,80,100,0.22)'; g.lineWidth = 0.8; g.stroke(); g.restore(); }
      const cg = g.createRadialGradient(top.x - 1, top.y - 1, 0.5, top.x, top.y, 4.2); cg.addColorStop(0, '#fff2a8'); cg.addColorStop(1, s.k.c);
      g.fillStyle = cg; g.beginPath(); g.arc(top.x, top.y, 3.8, 0, TAU); g.fill();
    });
    return cv;
  }

  function rockPath(g, cx, cy, rx, ry, rand) {
    const n = 9; const pts = [];
    for (let i = 0; i < n; i += 1) { const a = (i / n) * TAU + rand() * 0.25; const k = 0.82 + rand() * 0.28; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k * (Math.sin(a) > 0 ? 0.78 : 1)]); }
    g.beginPath(); pts.forEach(([x, y], i) => { const [px, py] = pts[(i + n - 1) % n]; const mx = (px + x) / 2; const my = (py + y) / 2; if (i === 0) g.moveTo(mx, my); else g.quadraticCurveTo(px, py, mx, my); });
    const [lx, ly] = pts[n - 1]; const [fx, fy] = pts[0]; g.quadraticCurveTo(lx, ly, (lx + fx) / 2, (ly + fy) / 2); g.closePath();
  }
  function drawRock(g, cx, cy, rx, ry, seed) {
    const rand = rng(seed);
    groundShadow(g, cx + rx * 0.3, cy + ry * 0.7, rx * 1.25, rx * 0.28, 0.45);
    g.save(); rockPath(g, cx, cy, rx, ry, rng(seed)); g.clip();
    const grad = g.createLinearGradient(cx - rx, cy - ry, cx + rx * 0.9, cy + ry);
    grad.addColorStop(0, '#e6e8e2'); grad.addColorStop(0.45, '#a3aaa6'); grad.addColorStop(1, '#5c6663');
    g.fillStyle = grad; g.fillRect(cx - rx * 1.4, cy - ry * 1.4, rx * 2.8, ry * 2.8);
    // 면(결)
    g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.moveTo(cx - rx * 0.9, cy - ry * 0.2); g.lineTo(cx - rx * 0.2, cy - ry); g.lineTo(cx + rx * 0.3, cy - ry * 0.7); g.lineTo(cx - rx * 0.3, cy - ry * 0.1); g.closePath(); g.fill();
    g.fillStyle = 'rgba(35,45,45,0.28)'; g.beginPath(); g.moveTo(cx + rx * 0.2, cy + ry * 0.1); g.lineTo(cx + rx, cy - ry * 0.2); g.lineTo(cx + rx * 0.8, cy + ry); g.lineTo(cx - rx * 0.1, cy + ry); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(50,60,60,0.38)'; g.lineWidth = 1.6; for (let i = 0; i < 4; i += 1) { g.beginPath(); const x = cx + (rand() - 0.5) * rx * 1.4; const y = cy + (rand() - 0.2) * ry; g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 22, y + 8 + rand() * 12); g.stroke(); }
    // 이끼: 위쪽과 왼쪽에 모인다
    for (let i = 0; i < 9; i += 1) { const x = cx + (rand() - 0.62) * rx * 1.5; const y = cy - ry * (0.2 + rand() * 0.75); blob(g, x, y, 6 + rand() * 10, '#b8e276', '#67ad4c', '#3c7c3e'); }
    g.restore();
    g.strokeStyle = 'rgba(55,64,62,0.55)'; g.lineWidth = 2; rockPath(g, cx, cy, rx, ry, rng(seed)); g.stroke();
  }
  function makeRocks() {
    const [cv, g] = canvas(240, 190);
    drawRock(g, 150, 128, 44, 36, 5); drawRock(g, 84, 138, 52, 40, 9); drawRock(g, 126, 96, 30, 24, 14);
    const rand = rng(3); for (let i = 0; i < 26; i += 1) { const x = 36 + rand() * 170; blade(g, x, 160 + rand() * 6, 12 + rand() * 12, (rand() - 0.5) * 10, 2, rand() < 0.5 ? '#3d9548' : '#7ccb58'); }
    return cv;
  }

  function makeBranch() {
    const [cv, g] = canvas(240, 160); const rand = rng(23);
    groundShadow(g, 126, 140, 98, 98 * 0.17, 0.4);
    const main = (w, color, dy = 0) => { g.strokeStyle = color; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(34, 126 + dy); g.bezierCurveTo(78, 124 + dy, 140, 104 + dy, 206, 72 + dy); g.stroke(); };
    // 곁가지
    g.lineCap = 'round'; [[92, 118, 80, 84], [130, 108, 148, 70], [170, 90, 204, 100]].forEach(([x0, y0, x1, y1]) => { g.strokeStyle = '#3d2a1c'; g.lineWidth = 11; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.strokeStyle = '#7e5a3a'; g.lineWidth = 6; g.beginPath(); g.moveTo(x0, y0 - 1); g.lineTo(x1, y1 - 1); g.stroke(); });
    main(24, '#34231a'); main(20, '#6a4a30', -1); main(14, '#8a6542', -3); main(5, 'rgba(235,200,150,0.7)', -7);
    g.strokeStyle = 'rgba(40,26,18,0.55)'; g.lineWidth = 1.6; for (let i = 0; i < 16; i += 1) { const t = rand(); const x = lerp(48, 196, t); const y = 124 - t * 50 + (rand() - 0.5) * 8; g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 8 + rand() * 6, y + 4); g.stroke(); }
    // 잘린 단면
    const rg = g.createRadialGradient(30, 124, 2, 30, 126, 14); rg.addColorStop(0, '#f2d39e'); rg.addColorStop(1, '#c79c61');
    g.fillStyle = rg; g.strokeStyle = '#3d2a1c'; g.lineWidth = 3; g.beginPath(); g.ellipse(30, 126, 9, 13, 0.1, 0, TAU); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(130,90,50,0.7)'; g.lineWidth = 1.4; g.beginPath(); g.ellipse(30, 126, 5, 8, 0.1, 0, TAU); g.stroke(); g.beginPath(); g.ellipse(30, 126, 2, 3.5, 0.1, 0, TAU); g.stroke();
    // 이끼와 잎
    for (let i = 0; i < 6; i += 1) blob(g, 70 + rand() * 90, 108 - rand() * 18, 6 + rand() * 6, '#b8e276', '#67ad4c', '#3c7c3e');
    [[80, 82], [148, 68], [204, 98], [182, 76]].forEach(([x, y]) => { for (let k = 0; k < 3; k += 1) leaf(g, x + k * 6 - 6, y - k * 3, 11, -0.6 + k * 0.7, k % 2 ? '#7fd05a' : '#4fae50', 0.95); });
    return cv;
  }

  function makeTuft() {
    const [cv, g] = canvas(140, 110); const rand = rng(61);
    groundShadow(g, 72, 96, 48, 9, 0.28);
    for (let i = 0; i < 48; i += 1) blade(g, 30 + rand() * 80, 96, 28 + rand() * 40, (rand() - 0.5) * 34, 2.6, i % 3 ? '#4aa04d' : (i % 2 ? '#8fd35c' : '#2f8445'));
    return cv;
  }

  function makeReeds() {
    const [cv, g] = canvas(260, 280); const rand = rng(83); const base = 246;
    // 잔물결과 연잎
    g.strokeStyle = 'rgba(235,255,250,0.55)'; g.lineWidth = 2; for (let i = 0; i < 3; i += 1) { g.beginPath(); g.ellipse(130, base + 4, 70 + i * 22, 16 + i * 5, 0, 0, TAU); g.globalAlpha = 0.5 - i * 0.14; g.stroke(); } g.globalAlpha = 1;
    drawLilyPad(g, 78, base + 2, 22, 3, rng(2)); drawLilyPad(g, 190, base - 4, 18, 1, rng(5));
    const stems = [];
    for (let i = 0; i < 20; i += 1) stems.push({ x: 90 + rand() * 80, h: 120 + rand() * 120, bend: (rand() - 0.5) * 36, cat: rand() < 0.4 });
    stems.sort((a, b) => b.h - a.h);
    stems.forEach((s) => {
      g.strokeStyle = s.cat ? '#6f9a4a' : '#7fae52'; g.lineWidth = s.cat ? 3 : 2.6; g.lineCap = 'round'; g.beginPath(); g.moveTo(s.x, base); g.quadraticCurveTo(s.x + s.bend * 0.2, base - s.h * 0.6, s.x + s.bend, base - s.h); g.stroke();
      if (s.cat) { g.save(); g.translate(s.x + s.bend, base - s.h + 12); g.rotate(s.bend * 0.012); const cg = g.createLinearGradient(-4, 0, 4, 0); cg.addColorStop(0, '#b8844f'); cg.addColorStop(1, '#5e3a22'); g.fillStyle = cg; g.beginPath(); g.roundRect ? g.roundRect(-4.5, -24, 9, 38, 4.5) : g.rect(-4.5, -24, 9, 38); g.fill(); g.restore(); }
      else blade(g, s.x + s.bend, base - s.h, 22, s.bend * 0.3, 2, '#c9c276');
    });
    for (let i = 0; i < 18; i += 1) blade(g, 80 + rand() * 100, base, 60 + rand() * 80, (rand() - 0.5) * 44, 3, i % 2 ? '#5aa550' : '#8cc45e');
    return cv;
  }

  function makeBench() {
    const [cv, g] = canvas(210, 130);
    groundShadow(g, 112, 106, 92, 12, 0.35);
    g.fillStyle = '#3a3a40'; [[34, 70], [162, 70]].forEach(([x, y]) => { g.fillRect(x, y, 8, 34); g.fillRect(x - 3, y + 30, 14, 5); });
    const slat = (y, h, c1, c2) => { const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(24, y, 164, h); g.strokeStyle = 'rgba(60,36,20,0.6)'; g.lineWidth = 1.4; g.strokeRect(24, y, 164, h); };
    slat(66, 12, '#c9a06a', '#a47a48'); slat(80, 12, '#c4996a', '#9c7342');
    slat(26, 12, '#d0a872', '#a98050'); slat(41, 12, '#cba26b', '#a47a48'); g.fillStyle = '#3a3a40'; g.fillRect(34, 26, 7, 46); g.fillRect(166, 26, 7, 46);
    g.strokeStyle = 'rgba(255,240,200,0.45)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(30, 68); g.lineTo(184, 68); g.stroke();
    return cv;
  }

  // ---------- 사람 ----------
  // phase: null이면 서 있는 모습, 숫자면 걷는 동작의 한 장면(0~2π). back: 뒷모습(위쪽으로 걸을 때)
  function makeCharacter(jacketColor, back, phase) {
    const [cv, g] = canvas(64, 92); const jacket = hex(jacketColor);
    const light = rgba(mix(jacketColor, 0xffffff, 0.35)); const base = rgba(jacket); const dark = rgba(mix(jacketColor, 0x1b2a28, 0.4));
    const walking = phase !== null;
    const s = walking ? Math.sin(phase) : 0;
    groundShadow(g, 34, 84, 24 - Math.abs(s) * 1.5, 6, 0.4);
    // 다리: 한쪽 발은 들리고 다른 쪽은 땅을 딛는다. 몸 앞/뒤로 뻗는 느낌을 위해 길이도 살짝 바뀐다.
    const legs = [[26, -s], [38, s]];
    legs.forEach(([x, k]) => {
      const lift = Math.max(0, k) * 9; const reach = k * 5;
      g.fillStyle = '#35507a'; g.fillRect(x - 4, 58 - reach * 0.4, 8, 18 + reach * 0.4 - lift);
      g.fillStyle = '#f2f0ea'; g.strokeStyle = 'rgba(40,40,50,0.6)'; g.lineWidth = 1.2;
      g.beginPath(); g.ellipse(x + k * 1.5, 78 - lift + reach * 0.5, 8, 4.5, 0, 0, TAU); g.fill(); g.stroke();
    });
    // 팔: 다리와 반대로 흔든다
    const armY = (k) => 46 + k * 6;
    const drawArms = () => {
      [[14, 0.18, s], [50, -0.18, -s]].forEach(([x, rot, k]) => {
        g.fillStyle = base; g.strokeStyle = 'rgba(30,45,42,0.7)'; g.lineWidth = 1.6; g.beginPath(); g.ellipse(x, armY(k), 5.4, 12, rot, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = '#f9cfa4'; g.beginPath(); g.arc(x + (x < 30 ? -2 : 2), armY(k) + 10, 4, 0, TAU); g.fill();
      });
    };
    if (back) drawArms();
    g.fillStyle = dark; g.beginPath(); g.ellipse(32, 52, 15, 7, 0, 0, TAU); g.fill();
    const bg = g.createLinearGradient(16, 34, 48, 62); bg.addColorStop(0, light); bg.addColorStop(0.5, base); bg.addColorStop(1, dark);
    g.fillStyle = bg; g.strokeStyle = 'rgba(30,45,42,0.7)'; g.lineWidth = 1.8; g.beginPath(); g.roundRect ? g.roundRect(16, 32, 32, 30, 11) : g.rect(16, 32, 32, 30); g.fill(); g.stroke();
    if (back) {
      // 가방
      const pg = g.createLinearGradient(20, 36, 44, 62); pg.addColorStop(0, '#f6c85a'); pg.addColorStop(1, '#c98f2e');
      g.fillStyle = pg; g.strokeStyle = 'rgba(90,60,20,0.7)'; g.beginPath(); g.roundRect ? g.roundRect(20, 35, 24, 24, 8) : g.rect(20, 35, 24, 24); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(90,60,20,0.5)'; g.beginPath(); g.moveTo(22, 46); g.lineTo(42, 46); g.stroke();
    } else { g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(31, 34, 2.4, 26); }
    if (!back) drawArms();
    // 머리
    const hg = g.createRadialGradient(27, 16, 2, 32, 22, 22); hg.addColorStop(0, '#ffe4c4'); hg.addColorStop(1, '#f1b98c');
    g.fillStyle = hg; g.strokeStyle = 'rgba(100,60,40,0.7)'; g.lineWidth = 1.6; g.beginPath(); g.arc(32, 22, 18, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#f1b98c'; g.beginPath(); g.arc(14, 24, 3.4, 0, TAU); g.arc(50, 24, 3.4, 0, TAU); g.fill();
    const hair = g.createLinearGradient(14, 4, 50, 22); hair.addColorStop(0, '#6a4c3a'); hair.addColorStop(1, '#3d2b2a');
    g.fillStyle = hair; g.beginPath();
    if (back) { g.arc(32, 22, 18.5, 0, TAU); g.fill(); g.strokeStyle = 'rgba(30,20,20,0.5)'; g.lineWidth = 1.4; g.stroke(); g.fillStyle = 'rgba(255,230,190,0.3)'; g.beginPath(); g.ellipse(25, 11, 7, 2.6, -0.4, 0, TAU); g.fill(); }
    else {
      g.moveTo(13, 22); g.bezierCurveTo(12, 2, 52, 2, 51, 22); g.bezierCurveTo(46, 12, 38, 11, 32, 14); g.bezierCurveTo(26, 11, 18, 13, 13, 22); g.fill();
      g.fillStyle = 'rgba(255,230,190,0.35)'; g.beginPath(); g.ellipse(24, 9, 6, 2.4, -0.4, 0, TAU); g.fill();
      g.fillStyle = '#2b3b45'; g.beginPath(); g.ellipse(26, 24, 2.2, 3, 0, 0, TAU); g.ellipse(38, 24, 2.2, 3, 0, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(26.8, 23, 0.9, 0, TAU); g.arc(38.8, 23, 0.9, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,130,130,0.4)'; g.beginPath(); g.ellipse(21, 30, 3.4, 2, 0, 0, TAU); g.ellipse(43, 30, 3.4, 2, 0, 0, TAU); g.fill();
      g.strokeStyle = '#8a4a3a'; g.lineWidth = 1.5; g.lineCap = 'round'; g.beginPath(); g.arc(32, 30, 4, 0.2, Math.PI - 0.2); g.stroke();
    }
    return cv;
  }
  const WALK_FRAMES = 8;
  function characterKey(color, back, frame) { return `char_${color}_${back ? 'b' : 'f'}_${frame === null ? 'idle' : frame}`; }

  // ---------- 빛 덮개(화면에 고정) ----------
  function makeLight(w, h) {
    const [cv, g] = canvas(w, h);
    const v = g.createRadialGradient(w / 2, h / 2, h * 0.38, w / 2, h / 2, h * 0.95); v.addColorStop(0, 'rgba(10,40,30,0)'); v.addColorStop(1, 'rgba(10,40,30,0.32)');
    g.fillStyle = v; g.fillRect(0, 0, w, h);
    const s = g.createRadialGradient(w * 0.12, -h * 0.08, 10, w * 0.12, -h * 0.08, w * 0.8); s.addColorStop(0, 'rgba(255,246,190,0.26)'); s.addColorStop(1, 'rgba(255,246,190,0)');
    g.fillStyle = s; g.fillRect(0, 0, w, h);
    return cv;
  }

  // ---------- 풍경 배치 ----------
  // 이미 놓여 있는 나무·덤불·바위 (R.STATIC_BLOCKERS와 같은 자리)
  const FLORA = [
    ['tree1', 225, 205, 0.92], ['tree2', 1050, 260, 0.8], ['tree3', 1080, 672, 0.88],
    ['tree1', 1450, 990, 0.96], ['tree2', 2180, 1120, 0.9], ['tree3', 2140, 640, 0.84],
    ['shrubFlower', 1125, 575, 0.9], ['shrubFlower', 920, 700, 0.74], ['shrubFlower', 1940, 1190, 0.78], ['shrubFlower', 2050, 840, 0.82], ['shrubFlower', 1320, 1070, 0.76],
    ['wildflowerPatch', 360, 445, 0.9], ['wildflowerPatch', 675, 325, 0.72], ['wildflowerPatch', 1010, 555, 0.84],
    ['mossyRocks', 1165, 680, 0.78], ['mossyRocks', 1260, 340, 0.66], ['mossyRocks', 650, 1290, 0.5], ['mossyRocks', 1440, 1320, 0.5],
    ['lilyReeds', 1400, 330, 0.8], ['lilyReeds', 1790, 610, 0.9], ['lilyReeds', 1650, 445, 0.66],
    ['grassTuft', 250, 685, 0.8], ['grassTuft', 460, 725, 0.9], ['grassTuft', 755, 670, 0.76], ['grassTuft', 1700, 1000, 0.8], ['grassTuft', 1980, 960, 0.8], ['grassTuft', 2100, 1050, 0.72],
    ['bench', 300, 1190, 0.8]
  ];

  const CHARACTER_COLORS = [0xf27b6a, 0x7146c4, 0xf4b942, 0x2987c5, 0x45a85a];

  function registerTextures(scene) {
    const tx = scene.textures;
    const add = (key, cv) => { if (!tx.exists(key)) tx.addCanvas(key, cv); };
    add('ground', paintGround());
    TREE_PALETTES.forEach((pal, i) => add(`tree${i + 1}`, makeTree(101 + i * 17, pal)));
    add('shrubFlower', makeShrub()); add('wildflowerPatch', makeWildflowers()); add('mossyRocks', makeRocks());
    add('fallenBranch', makeBranch()); add('grassTuft', makeTuft()); add('lilyReeds', makeReeds()); add('bench', makeBench());
    CHARACTER_COLORS.forEach((c) => [false, true].forEach((back) => {
      add(characterKey(c, back, null), makeCharacter(c, back, null));
      for (let f = 0; f < WALK_FRAMES; f += 1) add(characterKey(c, back, f), makeCharacter(c, back, (f / WALK_FRAMES) * TAU));
    }));
    add('lightOverlay', makeLight(960, 600));
  }

  // 나무·덤불 등을 장면에 놓는다. 뿌리 높이를 기준으로 사람과 앞뒤가 맞게 겹친다.
  function placeFlora(scene) {
    const sway = [];
    FLORA.forEach(([key, x, y, scale], i) => {
      const water = key === 'lilyReeds';
      const origin = key === 'tree1' || key === 'tree2' || key === 'tree3' ? 0.88 : 0.86;
      const image = scene.add.image(x, y, key).setOrigin(0.5, origin).setScale(scale);
      image.setDepth(key === 'grassTuft' ? 8 : 1000 + y);
      if (key.startsWith('tree') || water || key === 'wildflowerPatch' || key === 'grassTuft') sway.push({ image, phase: i * 1.7, amp: key.startsWith('tree') ? 0.7 : (water ? 1.6 : 1.2) });
    });
    return sway;
  }

  return { registerTextures, placeFlora, CHARACTER_COLORS, characterKey, WALK_FRAMES };
});
