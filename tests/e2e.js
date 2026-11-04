/*
 * 브라우저 통합 시험 (Playwright). 실행: node tests/e2e.js
 * 진짜 Supabase에는 접속하지 않고, 서버 규칙(0002 SQL)을 흉내 낸 가짜 서버를 Node에서 돌리며
 * 두 개의 브라우저 탭이 서로의 자연물·위치를 받는지까지 확인합니다.
 * 한계: 실제 Supabase Realtime/Auth의 동작은 이 시험으로 보장되지 않습니다(호출 모양·화면 동작만 확인).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const R = require('../placement-rules.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || path.join(__dirname, '../../shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CODE = 'ACDE3467';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

// ---------------- 정적 파일 서버 ----------------
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------- 가짜 Supabase 서버 ----------------
class FakeServer {
  constructor() {
    this.users = new Set(); this.members = new Map(); this.objects = []; this.attempts = new Map();
    this.pages = new Map(); this.channels = new Map(); this.seq = 1; this.lastWrite = new Map(); this.calls = [];
    this.signIns = 0; this.userCounter = 0;
  }
  log(name, extra) { this.calls.push({ name, ...extra }); }
  count(name) { return this.calls.filter((c) => c.name === name).length; }
  async handle(pageId, method, args) { return this[method](pageId, ...args); }
  signIn() { this.signIns += 1; this.userCounter += 1; const id = `00000000-0000-4000-8000-${String(this.userCounter).padStart(12, '0')}`; this.users.add(id); return { id }; }
  userExists(_p, id) { return this.users.has(id); }
  rpc(_p, uid, fn, a) {
    this.log(`rpc:${fn}`, { uid });
    const err = (message) => ({ data: null, error: { message, code: 'P0001' } });
    if (!uid || !this.users.has(uid)) return err('authentication required');
    if (fn === 'join_class') return { data: this.joinClass(uid, a.p_code), error: null };
    const member = this.members.get(uid);
    if (!member || member.revoked) return err('active class membership required');
    const active = () => this.objects.filter((o) => !o.deleted_at);
    const rate = () => { if (Date.now() - (this.lastWrite.get(uid) || 0) < 2000) throw new Error('nature object write rate exceeded'); };
    try {
      if (fn === 'create_nature_object') {
        rate();
        if (!R.KINDS[a.p_kind]) throw new Error('unsupported nature object kind');
        if (!(a.p_x >= 0 && a.p_x <= 2399 && a.p_y >= 0 && a.p_y <= 1499)) throw new Error('world bounds exceeded');
        if (active().length >= 300) throw new Error('world nature object limit reached');
        if (active().filter((o) => o.owner_id === uid).length >= 12) throw new Error('owner nature object limit reached');
        if (R.overlapsOthers(a.p_kind, a.p_x, a.p_y, active())) throw new Error('nature object overlaps another object');
        const row = { id: `obj-${this.seq++}`, world_id: a.p_world_id, owner_id: uid, kind: a.p_kind, x: a.p_x, y: a.p_y, rotation: a.p_rotation, scale: a.p_scale, version: 1, deleted_at: null };
        this.objects.push(row); this.lastWrite.set(uid, Date.now()); this.emitChange('INSERT', row);
        return { data: { ...row }, error: null };
      }
      if (fn === 'move_nature_object' || fn === 'delete_nature_object') {
        rate();
        const row = active().find((o) => o.id === a.p_object_id && o.owner_id === uid);
        if (!row) throw new Error('nature object not found');
        if (row.version !== a.p_expected_version) throw new Error('stale nature object version');
        if (fn === 'move_nature_object') {
          if (R.overlapsOthers(row.kind, a.p_x, a.p_y, active(), row.id)) throw new Error('nature object overlaps another object');
          Object.assign(row, { x: a.p_x, y: a.p_y, version: row.version + 1 });
        } else { row.deleted_at = new Date().toISOString(); row.version += 1; }
        this.lastWrite.set(uid, Date.now()); this.emitChange('UPDATE', row);
        return { data: { ...row }, error: null };
      }
    } catch (e) { return err(e.message); }
    return err('unknown function');
  }
  joinClass(uid, raw) {
    const code = String(raw).trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return { ok: false, reason: 'invalid_code', world_id: null };
    const att = this.attempts.get(uid) || { n: 0 };
    if (att.n >= 5) return { ok: false, reason: 'rate_limited', world_id: null };
    const existing = this.members.get(uid);
    if (existing && existing.revoked) return { ok: false, reason: 'membership_revoked', world_id: 'nature-prototype' };
    if (code !== CODE) { att.n += 1; this.attempts.set(uid, att); return { ok: false, reason: 'invalid_code', world_id: null }; }
    this.members.set(uid, { revoked: false });
    return { ok: true, reason: 'joined', world_id: 'nature-prototype' };
  }
  select(_p, uid, q) {
    this.log(`select:${q.table}`, { uid });
    if (!uid || !this.users.has(uid)) return { data: [], error: null };
    const member = this.members.get(uid);
    if (q.table === 'class_members') return { data: member && !member.revoked ? [{ world_id: 'nature-prototype' }] : [], error: null };
    if (q.table === 'nature_objects') {
      if (!member || member.revoked) return { data: [], error: null };
      return { data: this.objects.filter((o) => !o.deleted_at).map((o) => ({ ...o })), error: null };
    }
    return { data: [], error: { message: 'unknown table' } };
  }
  // ----- 실시간 -----
  emitChange(type, row) {
    for (const [, page] of this.pages) {
      page.evaluate((payload) => window.__pgDeliver && window.__pgDeliver(payload), { eventType: type, new: { ...row }, old: {} }).catch(() => {});
    }
  }
  presenceState(name) {
    const out = {};
    for (const [, e] of this.channels.get(name) || new Map()) if (e.key) out[e.key] = [e.payload];
    return out;
  }
  async chanJoin(pageId, name) { if (!this.channels.has(name)) this.channels.set(name, new Map()); this.channels.get(name).set(pageId, { key: null, payload: null }); }
  async chanSend(pageId, name, msg) {
    for (const [pid] of this.channels.get(name) || []) {
      if (pid === pageId) continue;
      const page = this.pages.get(pid);
      if (page) page.evaluate(([n, m]) => window.__busDeliver(n, { kind: 'broadcast', event: m.event, payload: m.payload }), [name, msg]).catch(() => {});
    }
  }
  async chanTrack(pageId, name, key, payload) {
    const ch = this.channels.get(name); if (!ch || !ch.has(pageId)) return;
    ch.set(pageId, { key, payload });
    await this.broadcastPresence(name, 'sync', []);
  }
  async chanUntrack(pageId, name) {
    const ch = this.channels.get(name); if (!ch || !ch.has(pageId)) return;
    const left = ch.get(pageId).payload ? [ch.get(pageId).payload] : [];
    ch.delete(pageId);
    await this.broadcastPresence(name, 'leave', left);
    await this.broadcastPresence(name, 'sync', []);
  }
  async broadcastPresence(name, event, left) {
    const state = this.presenceState(name);
    for (const [pid] of this.channels.get(name) || []) {
      const page = this.pages.get(pid);
      if (page) await page.evaluate(([n, m]) => window.__busDeliver(n, m), [name, { kind: 'presence', event, state, left }]).catch(() => {});
    }
  }
  dropPage(pageId) { for (const [name, ch] of this.channels) if (ch.has(pageId)) this.chanUntrack(pageId, name); this.pages.delete(pageId); }
  seedObjects(uid, n) { for (let i = 0; i < n; i += 1) this.objects.push({ id: `seed-${this.seq++}`, world_id: 'nature-prototype', owner_id: uid, kind: 'wildflower', x: 150 + (i % 6) * 120, y: 180 + Math.floor(i / 6) * 120, rotation: 0, scale: 1, version: 1, deleted_at: null }); }
  inject(row) { const full = { id: `inj-${this.seq++}`, world_id: 'nature-prototype', owner_id: 'someone-else', rotation: 0, scale: 1, version: 1, deleted_at: null, ...row }; this.objects.push(full); return full; }
}

// ---------------- 브라우저 쪽 가짜 supabase-js ----------------
const STUB = `
(() => {
  const pg = new Set(); const channels = new Map(); const KEY = 'fake-auth';
  const sess = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  window.__pgDeliver = (payload) => pg.forEach((fn) => fn(payload));
  window.__busDeliver = (name, msg) => { const ch = channels.get(name); if (ch) ch.deliver(msg); };
  window.supabase = { createClient() {
    return {
      auth: {
        getSession: async () => ({ data: { session: sess() } }),
        getUser: async () => { const s = sess(); if (!s) return { data: { user: null }, error: { message: 'no session' } }; const ok = await window.__srv('userExists', s.user.id); return ok ? { data: { user: s.user }, error: null } : { data: { user: null }, error: { message: 'user not found' } }; },
        signOut: async () => { localStorage.removeItem(KEY); return { error: null }; },
        signInAnonymously: async () => { const r = await window.__srv('signIn'); const s = { user: { id: r.id } }; localStorage.setItem(KEY, JSON.stringify(s)); return { data: { user: s.user, session: s }, error: null }; }
      },
      rpc: async (fn, args) => { const s = sess(); return await window.__srv('rpc', s && s.user.id, fn, args); },
      from: (table) => { const q = { table, filters: [] }; const b = { select() { return b; }, eq(c, v) { q.filters.push(['eq', c, v]); return b; }, is(c, v) { q.filters.push(['is', c, v]); return b; }, limit() { return b; }, then(res, rej) { const s = sess(); return window.__srv('select', s && s.user.id, q).then(res, rej); } }; return b; },
      channel: (name, opts) => {
        const handlers = []; const key = opts && opts.config && opts.config.presence && opts.config.presence.key;
        const ch = {
          name, _presence: {},
          on(type, filter, cb) { handlers.push({ type, filter, cb }); return ch; },
          subscribe(cb) {
            if (name.startsWith('db-nature-objects')) { ch._pg = (payload) => handlers.filter((h) => h.type === 'postgres_changes').forEach((h) => h.cb(payload)); pg.add(ch._pg); }
            else { channels.set(name, ch); window.__srv('chanJoin', name); }
            setTimeout(() => cb && cb(window.__failRealtime ? 'CHANNEL_ERROR' : 'SUBSCRIBED'), 20);
            return ch;
          },
          send(msg) { window.__srv('chanSend', name, msg); return Promise.resolve('ok'); },
          track(p) { window.__srv('chanTrack', name, key, p); return Promise.resolve('ok'); },
          untrack() { window.__srv('chanUntrack', name); },
          presenceState() { return ch._presence; },
          deliver(msg) {
            if (msg.kind === 'broadcast') handlers.filter((h) => h.type === 'broadcast' && h.filter.event === msg.event).forEach((h) => h.cb({ payload: msg.payload }));
            else { ch._presence = msg.state; handlers.filter((h) => h.type === 'presence' && h.filter.event === msg.event).forEach((h) => h.cb({ leftPresences: msg.left || [] })); }
          },
          close() { if (ch._pg) pg.delete(ch._pg); channels.delete(name); }
        };
        return ch;
      },
      removeChannel(ch) { ch.close(); }
    };
  } };
})();`;

// ---------------- 시험 도구 ----------------
let failures = 0; let passes = 0;
function check(cond, name, detail) {
  if (cond) { passes += 1; console.log(`  ✓ ${name}`); } else { failures += 1; console.log(`  ✗ ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 80) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return false; }

async function newClient(browser, fake, port, id, query = '?debug=1') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  fake.pages.set(id, page);
  await page.addInitScript((pid) => { window.__pageId = pid; window.__failRealtime = /failrt=1/.test(location.search); }, id);
  await page.exposeFunction('__srv', (method, ...args) => fake.handle(id, method, args));
  await page.route('**/vendor/supabase-js-2.45.4.umd.js', (route) => route.fulfill({ contentType: 'text/javascript', body: STUB }));
  await page.goto(`http://127.0.0.1:${port}/${query}`);
  return { page, errors, context, id };
}
const text = (page, sel) => page.locator(sel).first().innerText();
const status = (page) => text(page, '#np-status');
async function dbg(page, expr) { return page.evaluate(expr); }

async function enterWithCode(c, code, name) {
  await c.page.fill('#join-name', name || `별명${c.id}`);
  await c.page.fill('#join-code', code);
  await c.page.click('#join-button');
}
async function waitWorld(c) {
  return until(() => c.page.evaluate(() => !!(window.NatureGame && window.NatureGame.scene) && !document.getElementById('nature-panel').hidden), 40000);
}
async function waitCooldown(c) { await until(async () => (await text(c.page, '#np-cooldown')).trim() === '', 4000); }
// 후보 위치를 게임의 포인터 처리 경로(월드 좌표)로 직접 지정
async function pointAt(c, x, y) { await c.page.evaluate(([px, py]) => window.NatureGame.worldPointerHandler({ x: px, y: py }, 'down'), [x, y]); }

(async () => {
  const { server, port } = await serve();
  const fake = new FakeServer();
  const browser = await chromium.launch();
  try {
    // ===== 1. 입장 코드 화면 =====
    console.log('1. 입장 코드 화면');
    const A = await newClient(browser, fake, port, 'A');
    check(await until(() => A.page.locator('#join-card').isVisible()), '처음에는 입장 코드 화면이 보인다');
    check(await A.page.locator('#world-section').isHidden(), '월드 화면은 숨겨져 있다');
    check((await A.page.locator('#dev-enter').isHidden()), '개발용 입장 버튼은 보이지 않는다');
    check((await A.page.locator('#join-card').innerText()).includes('Supabase') === false, '개발용 Supabase 입력창이 학생 화면에 없다');
    check(await A.page.locator('canvas').count() === 0, '입장 전에는 게임 캔버스(그림 파일)를 불러오지 않는다');
    await A.page.fill('#join-code', 'ab-0o1i5s8b2z');
    const filtered = await A.page.inputValue('#join-code');
    check(filtered === 'A', '헷갈리는 글자는 입력 칸에서 바로 지워진다', filtered);
    check((await text(A.page, '#join-message')).includes('쓰지 않는 글자'), '지운 이유를 안내한다');
    // 이름(별명) 칸: 비어 있거나 출석 번호처럼 보이면 서버에 보내기 전에 막는다
    check((await text(A.page, '#name-hint')).includes('출석 번호나 진짜 이름은 쓰지 않아요'), '이름 칸 아래에 출석 번호·진짜 이름 금지 안내가 있다');
    await A.page.fill('#join-code', 'ACDE');
    await A.page.fill('#join-name', '   ');
    await A.page.click('#join-button');
    check((await text(A.page, '#join-message')).includes('이름(별명)을 적어'), '이름이 비면 안내만 보여 준다');
    await A.page.fill('#join-name', '12번');
    await A.page.click('#join-button');
    check((await text(A.page, '#join-message')).includes('출석 번호 말고'), '출석 번호처럼 보이는 이름은 막는다');
    await A.page.fill('#join-name', '<b>별빛토끼열두글자넘는이름</b>');
    const cleaned = await A.page.inputValue('#join-name');
    check(await A.page.evaluate(() => document.getElementById('join-name').maxLength) === 8, '이름 칸은 8글자까지만 받는다');
    await A.page.click('#join-button');
    check((await A.page.inputValue('#join-name')).length <= 8 && !/[<>]/.test(await A.page.inputValue('#join-name')), '이름에서 <> 는 지우고 8글자로 줄인다', cleaned);
    await A.page.fill('#join-name', '별빛토끼');
    await A.page.fill('#join-code', 'ACDE');
    await A.page.click('#join-button');
    check((await text(A.page, '#join-message')).includes('8자리'), '짧은 코드는 안내 문구만 보여 준다');
    check(fake.count('rpc:join_class') === 0 && fake.signIns === 0, '짧은 코드는 서버로 보내지 않는다(틀린 시도로 세지 않음)', { rpc: fake.count('rpc:join_class'), signIns: fake.signIns });
    await enterWithCode(A, 'KLMN3467');
    check(await until(async () => (await text(A.page, '#join-message')).includes('코드가 맞지 않아요')), '틀린 코드는 친절한 문구가 나온다');
    check(await A.page.locator('#world-section').isHidden(), '틀린 코드로는 들어가지 못한다');

    // ===== 2. 입장 =====
    console.log('2. 입장');
    await enterWithCode(A, CODE);
    const okA = await waitWorld(A);
    if (!okA) console.log('DEBUG', await A.page.evaluate(() => ({msg: document.getElementById('join-message').innerText, joinHidden: document.getElementById('join-card').hidden, worldHidden: document.getElementById('world-section').hidden, panelHidden: document.getElementById('nature-panel').hidden, scene: !!(window.NatureGame&&window.NatureGame.scene), status: document.getElementById('location-status').innerText})), A.errors);
    check(okA, '맞는 코드로 월드에 들어가고 설치 패널이 보인다');
    check(await A.page.locator('#game canvas').count() === 1, '게임 캔버스가 만들어진다');
    check(fake.signIns === 1, '익명 로그인은 한 번만 했다', fake.signIns);
    await A.page.screenshot({ path: path.join(SHOTS, 'e2e-01-entered.png') });

    // 새로고침: 저장된 로그인 + 학급 멤버 확인으로 코드 없이 바로 입장
    await A.page.reload();
    check(await waitWorld(A), '새로고침하면 코드를 다시 묻지 않고 바로 입장한다');
    check(fake.signIns === 1, '새로고침해도 새 익명 계정을 만들지 않는다(로그인 한도 보호)', fake.signIns);

    // ===== 3. 두 번째 학생 =====
    console.log('3. 두 번째 학생과 함께');
    const B = await newClient(browser, fake, port, 'B');
    await enterWithCode(B, CODE);
    check(await waitWorld(B), 'B도 입장했다');
    check(await until(async () => (await A.page.evaluate(() => window.__nature.state.peers.size)) === 1, 5000), 'A가 B를 친구로 본다(접속 상태)');
    check(await until(async () => (await text(A.page, '#presence-summary')).includes('2명')), '접속자 수가 2명으로 표시된다');
    check(await until(async () => (await text(A.page, '#presence-list')).includes('별명B')), 'A 화면에 B가 입력한 이름이 보인다');
    check((await text(A.page, '#presence-list')).includes('별명A (나)'), 'A 자신의 이름에는 (나)가 붙고, 새로고침해도 이름이 유지된다', await text(A.page, '#presence-list'));
    // A가 걷는다 → B가 위치를 받는다
    const before = await B.page.evaluate(() => { const p = [...window.__nature.state.peers.values()][0]; return p ? { x: p.x, y: p.y } : null; });
    await A.page.locator('#game').focus();
    await A.page.keyboard.down('ArrowRight'); await sleep(2500); await A.page.keyboard.up('ArrowRight');
    const moved = await until(async () => { const p = await B.page.evaluate(() => { const q = [...window.__nature.state.peers.values()][0]; return q ? { x: q.x, y: q.y } : null; }); return p && before && p.x > before.x + 15; }, 4000);
    if (!moved) console.log('WALKDBG', await A.page.evaluate(() => ({me: window.NatureGame.getMe(), focus: document.activeElement && document.activeElement.id})), await B.page.evaluate(() => [...window.__nature.state.peers.values()]));
    check(!!moved, 'A가 걸으면 B 화면의 A 위치가 따라 움직인다', { before });

    // ===== 4. 자연물 놓기 =====
    console.log('4. 자연물 놓기');
    await A.page.click('.np-kind[data-kind="rock"]');
    check((await status(A.page)).includes('돌을 놓을 자리'), '돌을 고르면 안내가 나온다(조사 "을")', await status(A.page));
    check(await A.page.evaluate(() => window.NatureGame.inputLocked === true), '놓는 동안 캐릭터는 걷지 않는다');
    const me = await A.page.evaluate(() => ({ x: window.NatureGame.getMe().x, y: window.NatureGame.getMe().y }));
    await A.page.keyboard.press('ArrowRight'); await A.page.keyboard.press('ArrowRight');
    const afterKeys = await A.page.evaluate(() => ({ x: window.NaturePlacement.debug.placing.x, y: window.NaturePlacement.debug.placing.y, meX: window.NatureGame.getMe().x }));
    check(afterKeys.x === Math.round(me.x / 10) * 10 + 50, '방향키로 후보 위치가 25씩 움직인다', { afterKeys, me });
    check(Math.abs(afterKeys.meX - me.x) < 1, '그동안 캐릭터는 그대로다');
    await A.page.keyboard.press('Enter');
    check(await until(async () => (await status(A.page)).includes('돌을 놓았어요')), 'Enter로 놓으면 "돌을 놓았어요."');
    check(await A.page.evaluate(() => window.NatureGame.inputLocked === false), '다 놓으면 다시 걸을 수 있다');
    check((await text(A.page, '#np-count')).includes('내 자연물 1/12'), '내 자연물 개수가 1/12로 바뀐다');
    check(await until(async () => (await B.page.evaluate(() => window.NaturePlacement.debug.objects.size)) === 1, 4000), 'B 화면에도 곧바로 나타난다');
    check(fake.count('rpc:create_nature_object') === 1, '서버 호출은 한 번뿐이다');
    check((await text(A.page, '#np-cooldown')).includes('기다려'), '2초 쉬는 안내가 나온다');
    check(await A.page.locator('#np-list .np-item').count() === 1, '"내가 놓은 자연물" 목록에 한 줄 생긴다');

    // ===== 5. 거부 문구 (서버에 가기 전에 막는다) =====
    console.log('5. 놓을 수 없는 곳');
    await waitCooldown(A);
    await A.page.click('.np-kind[data-kind="wildflower"]');
    const createsBefore = fake.count('rpc:create_nature_object');
    for (const [name, x, y, word] of [['물', 1600, 600, '물 위'], ['길', 600, 850, '길 위'], ['나무 위', 225, 205, '나무나 덤불']]) {
      await pointAt(A, x, y);
      check((await status(A.page)).includes(word), `${name}: 안내 문구 "${word}"`, await status(A.page));
      check(await A.page.locator('#np-confirm').isDisabled(), `${name}: "여기에 놓기" 버튼이 꺼진다`);
    }
    await A.page.keyboard.press('Enter');
    check(fake.count('rpc:create_nature_object') === createsBefore, '막힌 자리에서 Enter를 눌러도 서버로 보내지 않는다');
    // 내 돌 바로 옆(겹침)
    const rock = [...await A.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()])][0];
    await pointAt(A, rock.x + 20, rock.y);
    check((await status(A.page)).includes('다른 자연물과 너무 가까워요'), '겹치면 "너무 가까워요"');
    await A.page.keyboard.press('Escape');
    check((await status(A.page)).includes('취소'), 'Esc로 취소할 수 있다');
    check(await A.page.locator('#np-confirm').isHidden(), '취소하면 놓기 버튼이 사라진다');

    // ===== 6. 서버만 아는 겹침 → 서버 오류 문구, 그리고 5초 안에 화면이 따라잡는다(폴링) =====
    console.log('6. 화면이 모르는 변경(서버 오류와 새로 읽기)');
    const hidden = fake.inject({ kind: 'shrub', x: 900, y: 330 }); // 이벤트 없이 서버에만 존재
    await A.page.click('.np-kind[data-kind="shrub"]');
    await pointAt(A, 900, 330);
    const knew = await A.page.evaluate((id) => window.NaturePlacement.debug.objects.has(id), hidden.id);
    check(knew || (await status(A.page)).includes('놓을 수 있어요'), '화면은 아직 모르므로 놓을 수 있다고 보인다(이미 새로 읽었다면 건너뜀)', await status(A.page));
    await A.page.keyboard.press('Enter');
    check(await until(async () => (await status(A.page)).includes('너무 가까워요')), '겹침이면(화면 또는 서버가 거절)  같은 문구로 안내한다');
    check(await until(async () => await A.page.evaluate((id) => window.NaturePlacement.debug.objects.has(id), hidden.id), 7000), '5초 안에 새로 읽어서 그 자연물이 화면에 나타난다');
    await A.page.keyboard.press('Escape');

    // ===== 7. 옮기기와 지우기 =====
    console.log('7. 옮기기와 지우기');
    await waitCooldown(A);
    await A.page.click('#np-list .np-item');
    check(await A.page.locator('#np-selected').isVisible(), '목록에서 고르면 옮기기·지우기가 보인다');
    await A.page.click('#np-move');
    await A.page.keyboard.press('ArrowDown'); await A.page.keyboard.press('ArrowDown');
    await A.page.keyboard.press('Enter');
    check(await until(async () => (await status(A.page)).includes('돌을 옮겼어요')), '옮기면 "돌을 옮겼어요."');
    const movedRow = await A.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].find((o) => o.version === 2));
    check(!!movedRow, '버전이 2로 올라간다');
    check(await until(async () => (await B.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].some((o) => o.version === 2))), 4000), 'B 화면에서도 옮겨진다');
    await waitCooldown(A);
    if (await A.page.locator('#np-delete').isHidden()) await A.page.click('#np-list .np-item');
    await A.page.click('#np-delete');
    console.log('DELDBG', await text(A.page, '#np-delete'), await status(A.page));
    check((await text(A.page, '#np-delete')).includes('한 번 더'), '지우기 첫 번째 누름: 한 번 더 누르라고 묻는다(확인창 없음)');
    check(fake.count('rpc:delete_nature_object') === 0, '첫 번째 누름에서는 서버로 보내지 않는다');
    await A.page.click('#np-delete');
    check(await until(async () => (await status(A.page)).includes('돌을 지웠어요')), '두 번째 누름에서 지워진다');
    check(await until(async () => !(await B.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].some((o) => o.kind === 'rock' && o.owner_id !== 'x' && o.version >= 2))), 4000), 'B 화면에서도 사라진다(삭제 UPDATE 이벤트)');

    // ===== 8. 친구 것은 못 건드린다 =====
    console.log('8. 친구가 놓은 것');
    const friendId = hidden.id;
    await A.page.evaluate((id) => window.NaturePlacement.debug.views.get(id).image.emit('pointerdown'), friendId);
    check(await A.page.locator('#np-selected').isVisible(), '친구 자연물을 누르면 안내가 보인다');
    check(await A.page.locator('#np-move').isHidden() && await A.page.locator('#np-delete').isHidden(), '옮기기·지우기 버튼은 없다');
    check((await text(A.page, '#np-sel-text')).includes('옮기거나 지울 수 없어요'), '이유를 말해 준다');

    // ===== 9. 내 자연물 12개 상한 =====
    console.log('9. 상한');
    const C = await newClient(browser, fake, port, 'C');
    await enterWithCode(C, CODE);
    await waitWorld(C);
    const cid = await C.page.evaluate(() => window.NatureGame.getMe().id);
    fake.seedObjects(cid, 12);
    await until(async () => (await C.page.evaluate(() => window.NaturePlacement.debug.objects.size)) >= 12, 7000);
    await C.page.click('.np-kind[data-kind="rock"]');
    check((await status(C.page)).includes('12개까지'), '12개를 넘기려 하면 안내한다', await status(C.page));

    // ===== 10. 실시간 연결이 막힌 경우 =====
    console.log('10. 실시간 연결이 막힌 학교 네트워크 흉내');
    const Dd = await newClient(browser, fake, port, 'D', '?debug=1&failrt=1');
    await enterWithCode(Dd, CODE);
    const okD = await waitWorld(Dd);
    if (!okD) console.log('DDBG', await Dd.page.evaluate(() => ({msg: document.getElementById('join-message').innerText, world: document.getElementById('world-section').hidden, panel: document.getElementById('nature-panel').hidden, scene: !!(window.NatureGame && window.NatureGame.scene), st: document.getElementById('location-status').innerText})), Dd.errors);
    check(okD, '실시간이 안 돼도 입장한다');
    check(await until(async () => (await text(Dd.page, '#realtime-note')).includes('자연물은 함께 볼 수 있어요')), '친구 움직임이 안 보인다는 점과 자연물은 보인다는 점을 알려 준다');
    check(await until(async () => (await Dd.page.evaluate(() => window.NaturePlacement.debug.objects.size)) >= 12, 7000), '그래도 자연물은 새로 읽기로 보인다');

    // ===== 11. 열두 가지 모두 놓은 장면 =====
    console.log('11. 열두 가지 자연물과 그림 버튼');
    for (const c of [B, C, Dd]) await c.context.close(); // 소프트웨어 렌더링이라 탭이 많으면 느려지므로 정리
    const E = await newClient(browser, fake, port, 'E');
    await enterWithCode(E, CODE); const okE = await waitWorld(E);
    if (!okE) console.log('EDBG', await E.page.evaluate(() => ({msg: document.getElementById('join-message').innerText, url: location.href, hasPanel: !!document.getElementById('np-cooldown'), body: document.body.innerText.slice(0,200)})), E.errors);
    check(await E.page.locator('#np-kinds .np-kind').count() === 12, '자연물 버튼이 12개다');
    check((await E.page.evaluate(() => [...document.querySelectorAll('#np-kinds .np-kind')].every((b) => b.innerText.trim() === '' && b.querySelector('canvas') && b.getAttribute('aria-label')))), '버튼에는 글자 없이 그림(canvas)만 있고, 이름은 aria-label에만 있다');
    check((await E.page.evaluate(() => [...document.querySelectorAll('#np-kinds .np-kind')].map((b) => b.getAttribute('aria-label')).join(','))) === '돌,꽃,작은 나무,다람쥐,토끼,나비,작은 연못,갈대,덩굴,벌집,물고기,수련', '이름은 쉬운 말이다(관목 → 작은 나무)');
    check((await E.page.evaluate(() => [...document.querySelectorAll('#np-kinds .np-kind canvas')].every((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 40) if (d[i] > 30) n += 1; return n > 80; }))), '모든 버튼 그림이 비어 있지 않다');
    // 규칙 안내: 벌집은 나무에만, 물고기는 물에만
    await waitCooldown(E);
    await E.page.click('.np-kind[data-kind="beehive"]'); await pointAt(E, 640, 520);
    check((await status(E.page)).includes('나무에만'), '벌집을 풀밭에 놓으려 하면 "나무에만" 안내', await status(E.page));
    check(await E.page.locator('#np-confirm').isDisabled(), '그 자리에서는 놓기 버튼이 꺼진다');
    await E.page.keyboard.press('Escape');
    await E.page.click('.np-kind[data-kind="fish"]'); await pointAt(E, 640, 520);
    check((await status(E.page)).includes('물 위에만'), '물고기를 풀밭에 놓으려 하면 "물 위에만" 안내', await status(E.page));
    await E.page.keyboard.press('Escape');
    await E.page.click('.np-kind[data-kind="waterlily"]'); await pointAt(E, 640, 520);
    check((await status(E.page)).includes('물 위에만'), '수련도 풀밭에는 놓을 수 없다');
    await E.page.keyboard.press('Escape');
    const spots = [['rock', 560, 560], ['wildflower', 700, 640], ['shrub', 820, 520], ['squirrel', 460, 640], ['rabbit', 440, 520], ['butterfly', 700, 480],
      ['pond', 1020, 430], ['reed', 560, 380], ['vine', 480, 420], ['beehive', 1080, 600], ['fish', 1500, 300], ['waterlily', 1560, 260]];
    for (const [kind, x, y] of spots) {
      await waitCooldown(E);
      await E.page.click(`.np-kind[data-kind="${kind}"]`);
      await pointAt(E, x, y);
      await E.page.keyboard.press('Enter');
      const placed = await until(async () => (await E.page.evaluate((k) => [...window.NaturePlacement.debug.objects.values()].some((o) => o.kind === k && o.owner_id === window.NatureGame.getMe().id), kind)), 4000);
      if (!placed) console.log('PLACEDBG', kind, await status(E.page));
      check(placed, `${kind} 놓기`);
    }
    check((await E.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].filter((o) => o.owner_id === window.NatureGame.getMe().id).length)) === 12, '열두 종류를 모두 놓았다');
    const hive = await E.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].find((o) => o.kind === 'beehive'));
    check(hive && hive.x === 1080 && hive.y === 672, '벌집은 눌러 준 자리가 아니라 나무 뿌리 자리(저장 좌표)에 붙는다', hive);
    // 두 번째 벌집은 같은 나무에 달 수 없다
    await waitCooldown(E);
    await E.page.click('.np-kind[data-kind="rock"]'); await E.page.keyboard.press('Escape');
    // (내 12개를 다 썼으므로 상한 문구가 먼저 나온다. 같은 나무 규칙은 단위 시험에서 확인)
    // 카메라를 그 장면으로 옮겨서 캡처
    await E.page.evaluate(() => { const m = window.NatureGame.getMe(); m.x = 640; m.y = 470; window.NatureGame.scene.anchor.setPosition(640, 470); });
    await sleep(1200);
    await E.page.screenshot({ path: path.join(SHOTS, 'e2e-02-all-kinds.png') });
    await E.page.evaluate(() => { const m = window.NatureGame.getMe(); m.x = 1330; m.y = 330; window.NatureGame.scene.anchor.setPosition(1330, 330); });
    await sleep(1200);
    await E.page.screenshot({ path: path.join(SHOTS, 'e2e-02b-pond-things.png') });
    await A.page.screenshot({ path: path.join(SHOTS, 'e2e-03-A-panel.png') });

    // ===== 11b. 걷기: 서서히 빨라지고, 자연물과 나무를 뚫지 못한다 =====
    console.log('11b. 걷기와 막힘');
    const walk = async (page, key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
    await E.page.evaluate(() => { const m = window.NatureGame.getMe(); m.x = 540; m.y = 470; window.NatureGame.scene.anchor.setPosition(540, 470); window.NatureGame.scene.vel = { x: 0, y: 0 }; });
    // 시계에 흔들리지 않도록 게임 루프를 멈추고, 1/60초씩 직접 걸음을 계산해서 속도 변화를 본다.
    const prof = await E.page.evaluate(() => {
      const sc = window.NatureGame.scene; sc.sys.game.loop.sleep();
      sc.vel = { x: 0, y: 0 }; const out = {};
      sc.cursors.right.isDown = true;
      for (let i = 1; i <= 60; i += 1) { sc.stepPlayer(1 / 60); if (i === 3) out.early = sc.vel.x; if (i === 45) out.cruise = sc.vel.x; }
      sc.cursors.right.isDown = false;
      sc.stepPlayer(1 / 60); sc.stepPlayer(1 / 60); out.mid = sc.vel.x;
      for (let i = 0; i < 40; i += 1) sc.stepPlayer(1 / 60);
      out.stopped = sc.vel.x; sc.sys.game.loop.wake(); return out;
    });
    const { early, cruise, mid, stopped } = prof;
    check(early < cruise * 0.6, '출발할 때 속도가 서서히 붙는다', { early, cruise });
    check(cruise > 150 && cruise <= 186, '조금 지나면 걷는 속도(약 185)에 이른다', cruise);
    check(mid > 0 && mid < cruise * 0.8, '멈출 때 속도가 서서히 줄어든다', { mid, cruise });
    check(stopped === 0, '곧 완전히 선다', stopped);
    await E.page.locator('#game').focus();
    // 내가 놓은 돌(700,560 근처 말고 실제 좌표)로 걸어가기: 돌 몸통 반경 24 + 발 13 이내로는 못 들어간다
    const rockRow = await E.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].find((o) => o.kind === 'rock'));
    await E.page.evaluate((r) => { const m = window.NatureGame.getMe(); m.x = r.x - 150; m.y = r.y - 30; window.NatureGame.scene.anchor.setPosition(m.x, m.y); window.NatureGame.scene.vel = { x: 0, y: 0 }; }, rockRow);
    await walk(E.page, 'ArrowRight', 1500);
    const nearRock = await E.page.evaluate(() => window.NatureGame.getMe());
    check(nearRock.x <= rockRow.x - 24 - 13 + 1, '돌을 뚫고 지나가지 못한다', { me: nearRock.x, rock: rockRow.x });
    check(nearRock.x > rockRow.x - 24 - 13 - 12, '돌 바로 앞까지는 간다', { me: nearRock.x, rock: rockRow.x });
    // 비스듬히 부딪히면 옆으로 미끄러진다
    await E.page.evaluate((r) => { const m = window.NatureGame.getMe(); m.x = r.x - 90; m.y = r.y - 30 - 40; window.NatureGame.scene.anchor.setPosition(m.x, m.y); window.NatureGame.scene.vel = { x: 0, y: 0 }; }, rockRow);
    await E.page.keyboard.down('ArrowRight'); await E.page.keyboard.down('ArrowDown'); await sleep(1800); await E.page.keyboard.up('ArrowRight'); await E.page.keyboard.up('ArrowDown');
    const slid = await E.page.evaluate(() => window.NatureGame.getMe());
    check(slid.x > rockRow.x + 20, '비스듬히 부딪히면 돌 옆으로 미끄러져 지나간다', { slid, rock: rockRow });
    const dist = Math.hypot(slid.x - rockRow.x, slid.y + 30 - rockRow.y);
    check(dist >= 24 + 13 - 1, '지나가면서도 돌 안으로 들어가지 않는다', dist);
    // 꽃은 지나갈 수 있다
    const flowerRow = await E.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].find((o) => o.kind === 'wildflower'));
    await E.page.evaluate((r) => { const m = window.NatureGame.getMe(); m.x = r.x - 100; m.y = r.y - 30; window.NatureGame.scene.anchor.setPosition(m.x, m.y); window.NatureGame.scene.vel = { x: 0, y: 0 }; }, flowerRow);
    await walk(E.page, 'ArrowRight', 1200);
    check((await E.page.evaluate(() => window.NatureGame.getMe().x)) > flowerRow.x + 20, '꽃밭은 지나갈 수 있다');
    // 이미 있던 나무 줄기(225,205)
    await E.page.evaluate(() => { const m = window.NatureGame.getMe(); m.x = 120; m.y = 175; window.NatureGame.scene.anchor.setPosition(m.x, m.y); window.NatureGame.scene.vel = { x: 0, y: 0 }; });
    await walk(E.page, 'ArrowRight', 1500);
    check((await E.page.evaluate(() => window.NatureGame.getMe().x)) <= 225 - 22 - 13 + 1, '원래 있던 나무도 뚫고 지나가지 못한다');
    // 친구가 놓은 돌도 막는다(다른 사람 것 포함)
    const fr = fake.inject({ kind: 'rock', x: 1000, y: 1000 });
    await until(async () => await E.page.evaluate((id) => window.NaturePlacement.debug.objects.has(id), fr.id), 7000);
    await E.page.evaluate(() => { const m = window.NatureGame.getMe(); m.x = 850; m.y = 970; window.NatureGame.scene.anchor.setPosition(m.x, m.y); window.NatureGame.scene.vel = { x: 0, y: 0 }; });
    await walk(E.page, 'ArrowRight', 1500);
    check((await E.page.evaluate(() => window.NatureGame.getMe().x)) <= 1000 - 24 - 13 + 1, '친구가 놓은 자연물도 뚫고 지나가지 못한다');
    // 작은 연못은 걸어 들어갈 수 있고 느려진다
    const pondRow = await E.page.evaluate(() => [...window.NaturePlacement.debug.objects.values()].find((o) => o.kind === 'pond'));
    check(await E.page.evaluate(([x, y]) => window.NaturePlacement.inPond(x, y), [pondRow.x, pondRow.y]), '작은 연못 안은 물로 판정된다(걸으면 느려진다)');

    // ===== 12. 콘솔 오류 =====
    console.log('12. 브라우저 콘솔 오류');
    for (const c of [A, B, C, Dd, E]) check(c.errors.length === 0, `${c.id}: 오류 없음`, c.errors.slice(0, 3));

    // ===== 13. 시험 모드(서버 없이) =====
    console.log('13. 시험 모드 (?dev=1)');
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dp = await ctx2.newPage(); const dErr = [];
    dp.on('pageerror', (e) => dErr.push(String(e))); dp.on('console', (m) => { if (m.type() === 'error') dErr.push(m.text()); });
    await dp.goto(`http://127.0.0.1:${port}/?dev=1`);
    check(await dp.locator('#dev-enter').isVisible(), '?dev=1 에서만 시험 입장 버튼이 보인다');
    await dp.click('#dev-enter');
    check(await until(() => dp.evaluate(() => !document.getElementById('nature-panel').hidden && window.NaturePlacement.debug.objects.size === 2)), '시험 모드: 친구 자연물 2개가 있다');
    await dp.screenshot({ path: path.join(SHOTS, 'e2e-04-dev.png') });
    check(dErr.length === 0, '시험 모드: 콘솔 오류 없음', dErr.slice(0, 3));
  } catch (error) {
    failures += 1; console.log('  ✗ 시험 도중 예외:', error);
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n통과 ${passes}, 실패 ${failures}`);
  process.exit(failures ? 1 : 0);
})();
