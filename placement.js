/*
 * 놓는 것 설치 화면: 패널(고르기·놓기·옮기기·지우기)과 게임 화면 위의 놓는 것 그리기.
 * 서버와의 통신은 data.js(NatureData)만 쓰고, 땅 규칙은 placement-rules.js(NatureRules)만 씁니다.
 */
(() => {
  'use strict';

  const R = window.NatureRules;
  const G = window.NatureGame;
  const $ = (id) => document.getElementById(id);

  let ctx = null; // { data, meId, mode, unsubscribe }
  const objects = new Map(); // id -> 행(row)
  const views = new Map(); // id -> { image, mark }
  let selectedId = null;
  let placing = null; // { type: 'create'|'move', kind, id?, x, y }
  let ghost = null;
  let ringGfx = null;
  let selGfx = null;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let shownId = null;
  let deleteArmedTimer = null;
  let busy = false;
  let syncNote = '';

  const els = () => ({
    panel: $('nature-panel'), note: $('np-note'), kinds: $('np-kinds'), confirm: $('np-confirm'), cancel: $('np-cancel'),
    status: $('np-status'), count: $('np-count'), list: $('np-list'), selected: $('np-selected'),
    selTitle: $('np-sel-title'), selText: $('np-sel-text'), move: $('np-move'), del: $('np-delete'), deselect: $('np-deselect'),
    worldState: $('world-state'), game: $('game')
  });
  let E = null;

  const snap = (v) => Math.round(v / 10) * 10;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mineList = () => [...objects.values()].filter((o) => o.owner_id === ctx.meId);
  const isMine = (o) => o && ctx && o.owner_id === ctx.meId;
  const label = (kind) => (R.KINDS[kind] ? R.KINDS[kind].label : '이것');
  const originY = (info) => (info.originY === undefined ? 0.86 : info.originY);
  const liftOf = (info) => info.lift || 0;
  const depthOf = (info, o) => (info.ground ? (info.originY === 0.5 && info !== R.KINDS.pond ? 10 + o.y / 10000 : 9) : 1000 + o.y);
  const iconBoxCache = new Map();

  function say(text, type = '') { E.status.textContent = text; E.status.dataset.type = type; }

  // ---------- 시작과 끝 ----------
  function start({ data, meId, mode }) {
    stop();
    E = els();
    ctx = { data, meId, mode, unsubscribe: null };
    const scene = G.scene;
    ringGfx = scene.add.graphics().setDepth(3000);
    selGfx = scene.add.graphics().setDepth(1990);
    E.panel.hidden = false;
    E.note.textContent = mode === 'mock' ? '시험 모드예요. 놓은 것은 이 화면에서만 보여요.' : '내가 놓은 것은 함께 있는 친구들 화면에도 보여요.';
    buildKindButtons();
    E.confirm.onclick = confirmPlacement;
    E.cancel.onclick = () => endPlacement('취소했어요.');
    E.move.onclick = () => { const o = objects.get(selectedId); if (o && isMine(o)) beginPlacement('move', o); };
    E.del.onclick = armOrDelete;
    E.deselect.onclick = () => deselect('선택을 풀었어요.');
    G.worldPointerHandler = onWorldPointer;
    window.addEventListener('keydown', onKeydown, true);
    ctx.unsubscribe = data.subscribe(onEvent, onSyncStatus);
    data.list().then((rows) => onSnapshot(rows, Date.now())).catch(() => say('놓은 것들을 불러오지 못했어요. 잠시 뒤에 다시 읽어 와요.', 'invalid'));
    renderLists();
    say('놓고 싶은 그림을 누르면 내 앞에 바로 놓여요. 내가 놓은 것을 화면에서 누르면 지워져요.');
  }

  function stop() {
    if (!ctx) return;
    try { if (ctx.unsubscribe) ctx.unsubscribe(); } catch (error) { /* 무시 */ }
    window.removeEventListener('keydown', onKeydown, true);
    G.worldPointerHandler = null; G.inputLocked = false;
    clearInterval(cooldownTimer); clearTimeout(deleteArmedTimer);
    views.forEach((v) => { v.image.destroy(); if (v.mark) v.mark.destroy(); (v.extras || []).forEach((e) => e.destroy()); });
    views.clear(); objects.clear();
    if (ghost) ghost.destroy(); if (ringGfx) ringGfx.destroy(); if (selGfx) selGfx.destroy();
    ghost = ringGfx = selGfx = null; placing = null; selectedId = null; busy = false; cooldownUntil = 0;
    if (E) E.panel.hidden = true;
    ctx = null;
  }

  // ---------- 놓는 것 고르기 버튼: 글자 없이 그림만 (이름은 소리 읽기용 aria-label에만) ----------
  // 텍스처에서 그림이 있는 부분만 잘라 정사각형 칸에 맞춰 그린다.
  function iconCanvas(kind, size) {
    const info = R.KINDS[kind];
    const tex = G.scene.textures.get(info.texture);
    const src = tex && tex.getSourceImage();
    const c = document.createElement('canvas');
    c.width = size * 2; c.height = size * 2; c.style.width = `${size}px`; c.style.height = `${size}px`; c.setAttribute('aria-hidden', 'true');
    if (!src) return c;
    let box = iconBoxCache.get(info.texture);
    if (!box) {
      const probe = document.createElement('canvas'); probe.width = src.width; probe.height = src.height;
      const pg = probe.getContext('2d'); pg.drawImage(src, 0, 0);
      const data = pg.getImageData(0, 0, probe.width, probe.height).data;
      let x0 = probe.width; let y0 = probe.height; let x1 = 0; let y1 = 0;
      for (let y = 0; y < probe.height; y += 1) for (let x = 0; x < probe.width; x += 1) if (data[(y * probe.width + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      box = x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: probe.width, h: probe.height };
      iconBoxCache.set(info.texture, box);
    }
    const pad = size * 0.16; const k = Math.min((c.width - pad) / box.w, (c.height - pad) / box.h);
    c.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, (c.width - box.w * k) / 2, (c.height - box.h * k) / 2, box.w * k, box.h * k);
    return c;
  }
  function buildKindButtons() {
    E.kinds.replaceChildren(...R.KIND_ORDER.map((kind) => {
      const info = R.KINDS[kind];
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'np-kind'; button.dataset.kind = kind; button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', info.label); button.title = info.label;
      if (info.inWater) button.dataset.need = 'water'; else if (info.onTree) button.dataset.need = 'tree';
      button.append(iconCanvas(kind, 46));
      button.addEventListener('click', () => quickPlace(kind));
      return button;
    }));
  }
  function markPressed(kind) { E.kinds.querySelectorAll('.np-kind').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind))); }

  // ---------- 그리기 ----------
  function objectView(o) {
    const info = R.KINDS[o.kind];
    if (!info) return null;
    let v = views.get(o.id);
    const scene = G.scene;
    if (!v) {
      if (!scene.textures.exists(info.texture)) return null;
      const image = scene.add.image(o.x, o.y, info.texture).setOrigin(0.5, originY(info));
      if (o.kind !== 'pond') { // 연못은 눌러도 선택되지 않게 한다(물 위를 눌러 걸어 들어갈 수 있도록). 목록에서 고른다.
        image.setInteractive({ useHandCursor: true });
        image.on('pointerdown', () => { // 내 놓는 것은 맵에서 한 번 누르면 바로 지워지고, 친구 것은 누르면 정보만 보인다
        if (placing) return; const cur = objects.get(o.id); if (!cur) return;
        if (isMine(cur)) removeMine(cur); else select(cur.id);
      });
      }
      v = { image, mark: null, extras: [], phase: (o.x * 0.013 + o.y * 0.007) % 6.28, baseScale: 1 };
      if (o.kind === 'beehive') for (let i = 0; i < 3; i += 1) v.extras.push(scene.add.image(o.x, o.y, 'obj_bee').setDisplaySize(15, 11.5));
      views.set(o.id, v);
    }
    v.baseScale = (info.displayWidth / v.image.width) * (o.scale || 1);
    v.image.setScale(v.baseScale).setPosition(o.x, o.y - liftOf(info)).setDepth(depthOf(info, o));
    // 내 것에는 발밑에 흰 고리를 그려 친구 것과 구분한다
    if (isMine(o) && !info.ground) {
      if (!v.mark) v.mark = scene.add.ellipse(0, 0, 10, 10).setStrokeStyle(3, 0xffffff, 0.95);
      const w = Math.max(40, Math.min(info.displayWidth, info.radius * 2) * 0.62);
      v.mark.setPosition(o.x, o.y + 3).setSize(w, w * 0.26).setDisplaySize(w, w * 0.26).setDepth(1000 + o.y - 0.2);
    } else if (isMine(o) && info.ground) {
      if (!v.mark) v.mark = scene.add.ellipse(0, 0, 10, 10).setStrokeStyle(3, 0xffffff, 0.95);
      const w = Math.min(info.displayWidth, info.radius * 2) * 0.62;
      v.mark.setPosition(o.x, o.y).setDisplaySize(w, w * 0.4).setDepth(depthOf(info, o) + 0.01);
    } else if (v.mark) { v.mark.destroy(); v.mark = null; }
    v.image.setAlpha(placing && placing.type === 'move' && placing.id === o.id ? 0.3 : 1);
    return v;
  }
  // 물고기·수련은 놓아 둔 연못이 사라지면 물이 없으니 숨긴다
  function refreshStranded() {
    const list = [...objects.values()];
    views.forEach((v, id) => {
      const o = objects.get(id); const info = o && R.KINDS[o.kind];
      if (!info || !info.inWater) return;
      const stranded = R.waterBlock(o.kind, o.x, o.y, list) === 'notwater';
      v.image.setVisible(!stranded); if (v.mark) v.mark.setVisible(!stranded);
    });
  }
  function dropView(id) { const v = views.get(id); if (v) { v.image.destroy(); if (v.mark) v.mark.destroy(); (v.extras || []).forEach((e) => e.destroy()); views.delete(id); } }

  function upsertObject(row) {
    if (!row) return;
    if (row.deleted_at) { removeObject(row.id); return; }
    const old = objects.get(row.id);
    if (old && old.version > row.version) return; // 더 최신 정보가 이미 있음
    objects.set(row.id, row);
    objectView(row);
    if (selectedId === row.id) showSelected();
    afterObjectsChanged();
  }
  function removeObject(id) {
    if (!objects.has(id)) return;
    const wasSelected = selectedId === id;
    objects.delete(id); dropView(id);
    if (wasSelected) deselect('선택했던 것이 사라졌어요.');
    if (placing && placing.type === 'move' && placing.id === id) endPlacement('옮기던 것이 사라졌어요.');
    afterObjectsChanged();
  }
  function onSnapshot(rows, startedAt) {
    if (!ctx || startedAt < (ctx.data.lastWriteAt || 0)) return; // 읽는 사이에 내가 바꾼 게 있으면 이번 결과는 버림
    const ids = new Set(rows.map((r) => r.id));
    rows.forEach(upsertObject);
    [...objects.keys()].forEach((id) => { if (!ids.has(id)) removeObject(id); });
  }
  function onEvent(event) {
    if (!ctx) return;
    if (event.type === 'upsert') upsertObject(event.row);
    else if (event.type === 'remove') removeObject(event.id);
    else if (event.type === 'snapshot') onSnapshot(event.rows, event.startedAt);
  }
  function onSyncStatus(status) {
    syncNote = status === 'live' ? '실시간으로 맞추는 중' : (status === 'mock' ? '시험 모드' : '5초마다 새로 읽는 중');
    renderWorldState();
  }
  function afterObjectsChanged() { renderLists(); renderWorldState(); refreshStranded(); if (placing) refreshCandidate(false); }
  function renderWorldState() { if (E && E.worldState) E.worldState.textContent = `놓인 것 ${objects.size}개${syncNote ? ` · ${syncNote}` : ''}`; }

  // ---------- 목록 ----------
  function renderLists() {
    if (!ctx) return;
    const mine = mineList();
    E.count.textContent = `내가 놓은 것 ${mine.length}/${R.PER_USER_LIMIT}개 · 친구들이 놓은 것 ${objects.size - mine.length}개`;
    E.list.replaceChildren(...mine.map((o) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'np-item'; b.dataset.id = o.id;
      b.setAttribute('aria-label', `${label(o.kind)} · ${R.zoneAt(o).name}`); b.title = label(o.kind);
      b.append(iconCanvas(o.kind, 34));
      b.setAttribute('aria-pressed', String(o.id === selectedId));
      b.addEventListener('click', () => select(o.id));
      li.append(b);
      return li;
    }));
    if (!mine.length) { const li = document.createElement('li'); li.className = 'np-empty'; li.textContent = '아직 놓은 것이 없어요.'; E.list.append(li); }
  }

  // ---------- 선택 ----------
  function select(id) {
    const o = objects.get(id);
    if (!o) return;
    if (placing) endPlacement();
    selectedId = id;
    showSelected();
    const mine = isMine(o);
    say(mine ? `내 ${R.eul(label(o.kind))} 골랐어요. 옮기거나 지울 수 있어요.` : `친구가 놓은 ${R.iyeyo(label(o.kind))}. 볼 수만 있고 옮기거나 지울 수 없어요.`);
    renderLists();
  }
  function showSelected() {
    const o = objects.get(selectedId);
    if (!o) { E.selected.hidden = true; selGfx.clear(); return; }
    const mine = isMine(o);
    E.selected.hidden = false;
    E.selTitle.textContent = `${mine ? '내' : '친구의'} ${label(o.kind)}`;
    E.selText.textContent = mine ? `${R.zoneAt(o).name}에 있어요.` : `${R.zoneAt(o).name}에 있어요. 친구가 놓은 것은 옮기거나 지울 수 없어요.`;
    E.move.hidden = !mine; E.del.hidden = !mine;
    // 같은 놓는 것을 다시 그리는 경우(새로 읽기 등)에는 '한 번 더 누르세요' 상태를 풀지 않는다.
    if (shownId !== selectedId) resetDeleteButton();
    shownId = selectedId;
    const info = R.KINDS[o.kind];
    const rw = Math.min(info.displayWidth * 0.8, info.radius * 1.9);
    selGfx.clear().lineStyle(5, 0xf2a900, 0.95).strokeEllipse(o.x, o.y + (info.ground ? 0 : 2), rw, rw * (info.ground ? 0.6 : 0.3));
  }
  function deselect(message) {
    selectedId = null; shownId = null;
    if (E) { E.selected.hidden = true; }
    if (selGfx) selGfx.clear();
    resetDeleteButton();
    if (message) say(message);
    renderLists();
  }

  // ---------- 버튼을 누르면 바로 놓기 ----------
  // 캐릭터가 보고 있는 방향 앞쪽에서 가장 가까운, 규칙에 맞는 빈자리를 찾아 곧바로 놓는다.
  // (벌집은 가까운 나무 뿌리, 물고기·수련은 가까운 물 위로 알아서 간다.) 자리가 마음에 안 들면 '옮기기'로 바꾼다.
  const FOOT_DY = 30; const FOOT_R = 13; // 캐릭터 발 위치(app.js와 같은 값)
  function findSpot(kind) {
    const info = R.KINDS[kind];
    const me = G.getMe(); const fx = me.x; const fy = me.y + FOOT_DY;
    const dir = G.facing || { x: 0, y: 1 };
    const bx = fx + dir.x * 90; const by = fy + dir.y * 90;
    const list = [...objects.values()];
    const startAngle = Math.atan2(dir.y, dir.x);
    const keepAway = info.collide ? info.collide + FOOT_R + 14 : 0; // 내 발밑에 놓아서 끼지 않게
    for (let r = 0; r <= 1500; r += 30) {
      const n = r === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * r) / 44));
      for (let i = 0; i < n; i += 1) {
        const a = startAngle + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * ((2 * Math.PI) / n); // 앞쪽부터 좌우로 번갈아
        const x = clamp(snap(bx + Math.cos(a) * r), 0, 2390); const y = clamp(snap(by + Math.sin(a) * r), 0, 1490);
        const check = R.validate(kind, x, y, list, null);
        if (!check.ok) continue;
        if (keepAway && Math.hypot(check.x - fx, check.y - fy) < keepAway) continue;
        return { x: check.x, y: check.y };
      }
    }
    return null;
  }

  async function quickPlace(kind) {
    if (!ctx || busy) return;
    if (placing) endPlacement(); // 옮기는 중이었다면 그만두고 새로 놓는다
    if (mineList().length >= R.PER_USER_LIMIT) { say(R.serverErrorMessage({ serverMessage: 'owner nature object limit reached' }), 'invalid'); return; }
    if (Date.now() < cooldownUntil) { say('잠깐만 쉬었다가 다시 눌러 주세요.', 'invalid'); return; }
    const spot = findSpot(kind);
    if (!spot) { say(`${R.eul(label(kind))} 놓을 수 있는 자리를 찾지 못했어요. 다른 곳으로 걸어가서 다시 눌러 보세요.`, 'invalid'); return; }
    setBusy(true);
    try {
      const row = await ctx.data.create({ kind, x: spot.x, y: spot.y });
      upsertObject(row);
      select(row.id);
      say(`${R.eul(label(kind))} ${R.zoneAt(row).name}에 놓았어요. 자리를 바꾸려면 '옮기기'를 눌러요.`, 'valid');
      startCooldown();
    } catch (error) {
      say(R.serverErrorMessage(error), 'invalid');
      if (/stale|not found|overlaps/.test((error && error.serverMessage) || (error && error.message) || '')) ctx.data.list().then((rows) => onSnapshot(rows, Date.now())).catch(() => {});
    } finally { setBusy(false); }
  }

  // ---------- 놓기·옮기기 ----------
  function beginPlacement(type, source) {
    if (!ctx || busy) return;
    const me = G.getMe();
    deselect();
    if (placing && placing.type === 'move') { const o = objects.get(placing.id); if (o) objectView(o); }
    placing = type === 'move'
      ? { type, kind: source.kind, id: source.id, x: source.x, y: source.y, cx: source.x, cy: source.y }
      : { type, kind: source.kind, x: clamp(snap(me.x), 0, 2390), y: clamp(snap(me.y), 0, 1490), cx: clamp(snap(me.x), 0, 2390), cy: clamp(snap(me.y), 0, 1490) };
    G.inputLocked = true;
    markPressed(placing.kind);
    if (ghost) ghost.destroy();
    const info = R.KINDS[placing.kind];
    ghost = G.scene.add.image(placing.x, placing.y - liftOf(info), info.texture).setOrigin(0.5, originY(info)).setAlpha(0.72).setDepth(2500);
    ghost.setScale(info.displayWidth / ghost.width);
    E.confirm.hidden = false; E.cancel.hidden = false;
    E.confirm.textContent = type === 'move' ? '여기로 옮기기' : '여기에 놓기';
    if (type === 'move') { const o = objects.get(placing.id); if (o) objectView(o); }
    if (E.game) E.game.focus({ preventScroll: true });
    refreshCandidate(true, true);
  }

  function endPlacement(message) {
    const wasMove = placing && placing.type === 'move' ? objects.get(placing.id) : null;
    placing = null; G.inputLocked = false;
    if (ghost) { ghost.destroy(); ghost = null; }
    if (ringGfx) ringGfx.clear();
    if (E) { E.confirm.hidden = true; E.cancel.hidden = true; markPressed(null); }
    if (wasMove) objectView(wasMove);
    if (message) say(message);
  }

  function refreshCandidate(announce, first) {
    if (!placing || !ctx) return;
    const info = R.KINDS[placing.kind];
    const check = R.validate(placing.kind, placing.cx, placing.cy, [...objects.values()], placing.id);
    placing.x = check.x; placing.y = check.y; // 벌집처럼 규칙에 따라 자리가 바뀌는 경우(나무 뿌리 자리)
    ghost.setPosition(placing.x, placing.y - liftOf(info)).setDepth(2500);
    ringGfx.clear()
      .fillStyle(check.ok ? 0x2f9e5b : 0xd1344a, 0.18).fillCircle(placing.x, placing.y, info.radius)
      .lineStyle(4, check.ok ? 0x176b43 : 0xba2636, 0.95).strokeCircle(placing.x, placing.y, info.radius);
    ghost.setTint(check.ok ? 0xffffff : 0xffb3bd);
    E.confirm.disabled = !check.ok || busy || Date.now() < cooldownUntil;
    placing.valid = check.ok;
    if (announce) {
      const how = '방향키로 옮기고 Enter로 놓아요. Esc는 취소예요.';
      say(first ? `${R.eul(label(placing.kind))} 놓을 자리를 골라요. ${check.message} ${how}` : check.message, check.ok ? 'valid' : 'invalid');
    }
  }

  function onWorldPointer(point) {
    if (!placing) return false;
    placing.cx = clamp(snap(point.x), 0, 2390); placing.cy = clamp(snap(point.y), 0, 1490);
    refreshCandidate(true);
    return true;
  }

  function onKeydown(event) {
    if (!placing) return;
    const t = event.target;
    const typing = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '');
    if (typing) return;
    const step = event.shiftKey ? 100 : 25;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (move) {
      event.preventDefault(); event.stopPropagation();
      placing.cx = clamp(placing.cx + move[0], 0, 2390); placing.cy = clamp(placing.cy + move[1], 0, 1490);
      refreshCandidate(true);
    } else if (event.key === 'Escape') {
      event.preventDefault(); endPlacement('취소했어요.');
    } else if ((event.key === 'Enter' || event.key === ' ') && !(t && t.tagName === 'BUTTON')) {
      event.preventDefault(); confirmPlacement();
    }
  }

  function setBusy(value) { busy = value; E.confirm.disabled = value || !(placing && placing.valid) || Date.now() < cooldownUntil; E.move.disabled = value || Date.now() < cooldownUntil; E.del.disabled = value || Date.now() < cooldownUntil; }

  function startCooldown() {
    cooldownUntil = Date.now() + R.WRITE_INTERVAL_MS;
    clearInterval(cooldownTimer);
    const tick = () => {
      const left = Math.max(0, cooldownUntil - Date.now());
      if (!left) { clearInterval(cooldownTimer); E.move.disabled = false; E.del.disabled = false; if (placing) refreshCandidate(false); }
    };
    E.move.disabled = true; E.del.disabled = true; if (placing) E.confirm.disabled = true;
    cooldownTimer = setInterval(tick, 100); tick();
  }

  async function confirmPlacement() {
    if (!placing || busy || !ctx) return;
    const check = R.validate(placing.kind, placing.cx, placing.cy, [...objects.values()], placing.id);
    if (!check.ok) { say(check.message, 'invalid'); return; }
    if (Date.now() < cooldownUntil) { say('잠깐만 쉬었다가 다시 눌러 주세요.', 'invalid'); return; }
    const { type, kind, id } = placing;
    const x = check.x; const y = check.y;
    setBusy(true);
    try {
      if (type === 'create') {
        const row = await ctx.data.create({ kind, x, y });
        upsertObject(row);
        endPlacement(`${R.eul(label(kind))} 놓았어요.`);
      } else {
        const o = objects.get(id);
        const row = await ctx.data.move({ id, x, y, expectedVersion: o ? o.version : 0 });
        upsertObject(row);
        endPlacement(`${R.eul(label(kind))} 옮겼어요.`);
      }
      startCooldown();
    } catch (error) {
      say(R.serverErrorMessage(error), 'invalid');
      if (/stale|not found/.test((error && error.serverMessage) || '')) ctx.data.list().then((rows) => onSnapshot(rows, Date.now())).catch(() => {});
    } finally {
      setBusy(false);
      if (placing) refreshCandidate(false);
    }
  }

  // ---------- 지우기 (한 번 더 눌러야 지워짐. 브라우저 확인창은 쓰지 않는다) ----------
  function resetDeleteButton() { clearTimeout(deleteArmedTimer); deleteArmedTimer = null; if (E) { E.del.textContent = '지우기'; E.del.dataset.armed = 'false'; } }
  async function armOrDelete() {
    const o = objects.get(selectedId);
    if (!o || !isMine(o) || busy) return;
    if (E.del.dataset.armed !== 'true') {
      E.del.dataset.armed = 'true'; E.del.textContent = '정말 지울까요? 한 번 더 누르세요';
      say(`${R.eul(label(o.kind))} 지우려면 버튼을 한 번 더 눌러 주세요.`, 'invalid');
      deleteArmedTimer = setTimeout(resetDeleteButton, 4000);
      return;
    }
    resetDeleteButton();
    await removeMine(o);
  }
  // 내 놓는 것 지우기(패널의 '지우기' 두 번 누르기와 맵에서 한 번 누르기가 함께 쓴다)
  async function removeMine(o) {
    if (!ctx || busy || !o || !isMine(o)) return;
    if (Date.now() < cooldownUntil) { say('잠깐만 쉬었다가 다시 눌러 주세요.', 'invalid'); return; }
    setBusy(true);
    try {
      const row = await ctx.data.remove({ id: o.id, expectedVersion: o.version });
      upsertObject(row); // deleted_at이 채워진 행이라 화면에서 사라진다
      say(`${R.eul(label(o.kind))} 지웠어요.`);
      startCooldown();
    } catch (error) {
      say(R.serverErrorMessage(error), 'invalid');
      if (/stale|not found/.test((error && error.serverMessage) || '')) ctx.data.list().then((rows) => onSnapshot(rows, Date.now())).catch(() => {});
    } finally { setBusy(false); }
  }

  // ---------- 살아 있는 움직임(나비 날갯짓, 물고기 헤엄, 벌 날기, 흔들리는 풀) ----------
  function animate(timeMs) {
    if (!ctx) return;
    const t = timeMs / 1000;
    views.forEach((v, id) => {
      const o = objects.get(id); if (!o || !v.image.visible) return;
      const info = R.KINDS[o.kind]; const ph = v.phase; const img = v.image;
      if (placing && placing.type === 'move' && placing.id === id) return;
      switch (o.kind) {
        case 'butterfly': {
          const tex = Math.floor(timeMs / 120) % 2 ? 'obj_butterfly_b' : 'obj_butterfly_a';
          if (img.texture.key !== tex) img.setTexture(tex);
          img.setPosition(o.x + Math.sin(t * 0.8 + ph) * 18, o.y - info.lift + Math.sin(t * 1.7 + ph) * 8).setAngle(Math.sin(t * 0.8 + ph) * 9);
          break;
        }
        case 'fish': {
          const a = t * 0.5 + ph;
          img.setPosition(o.x + Math.cos(a) * 9, o.y + Math.sin(a) * 4).setFlipX(Math.sin(a) > 0).setAngle(Math.cos(a) * 6 * (Math.sin(a) > 0 ? -1 : 1));
          break;
        }
        case 'waterlily': img.setScale(v.baseScale * (1 + Math.sin(t * 1.1 + ph) * 0.02)).setAngle(Math.sin(t * 0.7 + ph) * 2); break;
        case 'reed': case 'vine': img.setAngle(Math.sin(t * 0.9 + ph) * (o.kind === 'reed' ? 1.8 : 0.8)); break;
        case 'rabbit': case 'squirrel': img.setScale(v.baseScale * (1 + Math.sin(t * 1.6 + ph) * 0.012), v.baseScale * (1 + Math.cos(t * 1.6 + ph) * 0.018)); break;
        case 'beehive':
          v.extras.forEach((bee, i) => {
            const a = t * (2.4 + i * 0.5) + ph + i * 2.1; const rx = 24 + i * 5; const ry = 12 + i * 3;
            bee.setPosition(o.x + Math.cos(a) * rx, o.y - info.lift + 12 + Math.sin(a * 1.3) * ry).setDepth(1000 + o.y + 3).setFlipX(Math.sin(a) > 0);
          });
          break;
        default: break;
      }
    });
  }
  // 캐릭터가 지나가지 못하는 놓는 것 몸통, 그리고 걸어 들어갈 수 있는 작은 연못 판정 (app.js가 매 프레임 씀)
  function colliders() {
    const out = [];
    objects.forEach((o) => { const info = R.KINDS[o.kind]; if (info && info.collide > 0) out.push({ x: o.x, y: o.y, r: info.collide * (o.scale || 1) }); });
    return out;
  }
  function inPond(x, y) { if (!ctx) return false; return R.inUserPond(x, y, [...objects.values()], 0); }

  window.NaturePlacement = {
    start, stop, animate, colliders, inPond,
    debug: { findSpot, get objects() { return objects; }, get placing() { return placing; }, get views() { return views; }, get selectedId() { return selectedId; } }
  };
})();
