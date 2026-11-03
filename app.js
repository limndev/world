/* global Phaser, supabase */
(() => {
  'use strict';

  const R = window.NatureRules;
  const D = window.NatureData;
  const CONFIG = window.NATURE_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const DEV_MODE = params.get('dev') === '1'; // 시험용: ?dev=1 이면 서버 없이 입장하는 버튼이 보임

  const WORLD_ID = 'nature-prototype';
  const CHANNEL_NAME = `world:${WORLD_ID}`;
  const POSITION_INTERVAL = 300; // 위치 전송 간격(ms). 메시지 수를 줄이려고 이전(200)보다 늘림
  const PRESENCE_REFRESH = 15000; // 접속 상태는 입장할 때와 이 간격으로만 갱신(움직일 때마다 보내지 않음)
  const WORLD_WIDTH = R.WORLD_WIDTH;
  const WORLD_HEIGHT = R.WORLD_HEIGHT;
  const VIEWPORT_WIDTH = 960;
  const VIEWPORT_HEIGHT = 600;
  const LAND_SPEED = 185;
  const WATER_SPEED = 86;
  const ZONES = R.ZONES;
  const WATER_AREAS = R.WATER_AREAS;
  const isWater = R.isWater;
  const zoneAt = R.zoneAt;
  const session = window.sessionStorage;
  const NAME_KEY = 'nature-world-name';
  const NAME_MAX = 8;

  // 설치 기능(placement.js)이 게임 화면과 주고받는 창구
  const game = window.NatureGame = { scene: null, inputLocked: false, worldPointerHandler: null, getMe: () => state.me };

  const $ = (id) => document.getElementById(id);
  const elements = {
    status: $('connection-status'), joinCard: $('join-card'), joinForm: $('join-form'), joinName: $('join-name'), joinCode: $('join-code'), joinButton: $('join-button'),
    joinMessage: $('join-message'), devEnter: $('dev-enter'), worldSection: $('world-section'),
    people: $('presence-list'), summary: $('presence-summary'), location: $('location-status'), realtime: $('realtime-note')
  };

  let myId = session.getItem('nature-prototype-id') || crypto.randomUUID();
  const state = {
    mode: null, client: null, channel: null, data: null, phaser: null, scene: null, gamePromise: null, resolveScene: null,
    me: makePerson(myId), peers: new Map(), views: new Map(), lastSentAt: 0, seq: 0, lastReceived: new Map(),
    connected: false, realtime: 'idle', joining: false, hudDirty: true, lastHud: 0, lastZone: ''
  };

  function hash(value) { return [...value].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7); }
  // 이름(별명): 화면에 그대로 보이므로 제어 문자와 <> 를 지우고 8글자까지만 쓴다(다른 사람이 보낸 이름에도 같은 규칙을 적용).
  function cleanName(raw) { return Array.from(String(raw || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim(); }
  // 출석 번호처럼 보이는 이름(숫자만, 또는 "12번")은 막는다. 진짜 이름은 기계가 알 수 없어서 안내 문구로만 부탁한다.
  function nameProblem(name) {
    if (!name) return '이름(별명)을 적어 주세요.';
    if (/^[\d\s]+번?$/.test(name)) return '출석 번호 말고 나만의 별명을 적어 주세요.';
    return '';
  }
  function savedName() { try { return cleanName(window.localStorage.getItem(NAME_KEY)); } catch (error) { return ''; } }
  function saveName(name) { try { window.localStorage.setItem(NAME_KEY, name); } catch (error) { /* 저장 못 해도 입장은 된다 */ } }
  function makePerson(id, name) { const color = [0xf27b6a, 0x7146c4, 0xf4b942, 0x2987c5, 0x45a85a][hash(id) % 5]; return { id, name: cleanName(name) || `탐험가 ${id.slice(-4)}`, color, x: 560 + (hash(id) % 8) * 46, y: 510 + (hash(id) % 6) * 38, seq: 0, timestamp: Date.now() }; }
  function setStatus(text) { elements.status.textContent = text; }

  class NatureScene extends Phaser.Scene {
    constructor() { super('nature'); }
    preload() {} // 그림은 art.js가 시작할 때 직접 그립니다(그림 파일 없음)
    create() {
      state.scene = this;
      game.scene = this;
      this.ambientTime = 0;
      this.lastAmbientPaint = 0;
      this.drawWorld();
      this.cursors = this.input.keyboard.createCursorKeys();
      this.touchTarget = null;
      this.walking = false;
      this.input.keyboard.on('keydown', (event) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !isTypingTarget(event.target)) event.preventDefault();
      });
      this.input.on('pointerdown', (pointer) => {
        const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        if (game.worldPointerHandler && game.worldPointerHandler(point, 'down')) return; // 자연물 설치 중이면 위치 고르기로 씀
        if (this.input.hitTestPointer(pointer).length > 0) return; // 설치된 자연물을 눌렀을 땐 걷지 않고 선택만
        this.walking = true;
        this.touchTarget = point;
      });
      this.input.on('pointermove', (pointer) => {
        if (!pointer.isDown) return;
        const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        if (game.worldPointerHandler && game.worldPointerHandler(point, 'move')) return;
        if (this.walking) this.touchTarget = point;
      });
      this.input.on('pointerup', () => { this.touchTarget = null; this.walking = false; });
      this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      this.cameras.main.startFollow(this.playerAnchor(), true, 0.1, 0.1);
      this.cameras.main.setDeadzone(150, 100);
      this.cameras.main.setZoom(1);
      redraw();
      if (state.resolveScene) state.resolveScene(this);
    }
    playerAnchor() {
      this.anchor = this.add.zone(state.me.x, state.me.y, 1, 1).setVisible(false);
      return this.anchor;
    }
    update(_time, delta) {
      this.ambientTime += delta;
      if (this.ambientTime - this.lastAmbientPaint > 90) {
        this.drawAmbient(this.ambientTime / 1000);
        this.lastAmbientPaint = this.ambientTime;
      }
      smoothPeers(delta);
      animatePeople(this.ambientTime);
      if (this.sway) this.sway.forEach((s) => { s.image.setAngle(Math.sin(this.ambientTime / 1000 * 0.9 + s.phase) * s.amp); });
      if (state.hudDirty && this.ambientTime - state.lastHud > 250) { renderHud(); state.lastHud = this.ambientTime; }
      if (!state.connected || game.inputLocked) return; // 자연물을 놓는 중에는 캐릭터가 걷지 않는다
      const direction = new Phaser.Math.Vector2();
      if (this.cursors.left.isDown) direction.x -= 1;
      if (this.cursors.right.isDown) direction.x += 1;
      if (this.cursors.up.isDown) direction.y -= 1;
      if (this.cursors.down.isDown) direction.y += 1;
      if (direction.lengthSq() === 0 && this.touchTarget) {
        direction.set(this.touchTarget.x - state.me.x, this.touchTarget.y - state.me.y);
        if (direction.length() < 12) { this.touchTarget = null; direction.set(0, 0); }
      }
      if (direction.lengthSq() === 0) return;
      direction.normalize();
      const speed = isWater(state.me) ? WATER_SPEED : LAND_SPEED;
      state.me.x = Phaser.Math.Clamp(state.me.x + direction.x * speed * (delta / 1000), 38, WORLD_WIDTH - 38);
      state.me.y = Phaser.Math.Clamp(state.me.y + direction.y * speed * (delta / 1000), 58, WORLD_HEIGHT - 38);
      this.anchor.setPosition(state.me.x, state.me.y);
      state.me.timestamp = Date.now();
      placeMyView();
      state.hudDirty = true;
      sendLocation();
    }
    drawWorld() {
      const Art = window.NatureArt;
      Art.registerTextures(this);
      this.add.image(0, 0, 'ground').setOrigin(0).setDepth(0);
      this.sway = Art.placeFlora(this);
      this.ambient = this.add.graphics().setDepth(1400);
      this.drawAmbient(0);
      this.drawLandmarks();
      this.add.image(0, 0, 'lightOverlay').setOrigin(0).setScrollFactor(0).setDepth(1990);
    }
    drawAmbient(time) {
      if (!this.ambient) return;
      this.ambient.clear();
      for (let i = 0; i < 22; i += 1) {
        const x = 1330 + ((i * 103) % 640); const y = 255 + ((i * 71) % 510); const wave = Math.sin(time * 2 + i) * 6;
        this.ambient.lineStyle(2, 0xd8fff3, 0.45).lineBetween(x + wave, y, x + 35 + wave, y);
      }
      for (let i = 0; i < 9; i += 1) {
        const x = 350 + ((i * 251) % 1600) + Math.sin(time * 0.9 + i) * 20; const y = 250 + ((i * 137) % 850) + Math.cos(time * 1.1 + i) * 13;
        this.ambient.fillStyle(i % 2 ? 0xffcf4f : 0x8c68df).fillEllipse(x - 4, y, 9, 6).fillEllipse(x + 4, y, 9, 6).fillStyle(0x4a5f48).fillCircle(x, y, 2);
      }
      for (let i = 0; i < 13; i += 1) {
        const x = 1370 + ((i * 151) % 590); const y = 280 + ((i * 97) % 440); const sparkle = 0.35 + 0.25 * Math.sin(time * 3 + i);
        this.ambient.fillStyle(0xffffff, sparkle).fillCircle(x, y, 2 + (i % 2));
      }
    }
    drawLandmarks() {
      const labelStyle = { fontFamily: 'Pretendard, sans-serif', fontSize: '17px', fontStyle: 'bold', color: '#225343', backgroundColor: '#fffce9dd', padding: { x: 9, y: 5 } };
      ZONES.forEach((zone) => this.add.text(zone.x + 22, zone.y + 20, zone.name, labelStyle).setDepth(1500));
      this.add.text(32, 26, '☀ 함께 걷는 자연 탐험', { fontFamily: 'Pretendard, sans-serif', fontSize: '23px', fontStyle: 'bold', color: '#225343', backgroundColor: '#fffce9e8', padding: { x: 12, y: 8 } }).setScrollFactor(0).setDepth(2000);
    }
  }

  function isTypingTarget(target) { return !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''); }

  // ---------- 사람(캐릭터) 그리기: 한 번 만들고 위치만 옮긴다 ----------
  function buildPersonView(person, isMe) {
    const scene = state.scene;
    const container = scene.add.container(person.x, person.y).setName(`person-${person.id}`).setDepth(1000 + person.y);
    const jacket = person.color;
    const label = scene.add.text(-39, 29, isMe ? '나' : person.name, { fontFamily: 'Pretendard, sans-serif', fontSize: '12px', fontStyle: 'bold', color: '#21443b', backgroundColor: '#fffce9e8', padding: { x: 5, y: 2 } });
    const sprite = scene.add.image(0, 30, window.NatureArt.characterKey(jacket, false, null)).setOrigin(0.5, 0.95);
    const ring = isMe ? scene.add.ellipse(0, 21, 44, 15).setStrokeStyle(3, 0xffffff, 0.9) : null;
    label.setOrigin(0.5, 0).setPosition(0, 38);
    container.add(ring ? [ring, sprite, label] : [sprite, label]);
    return { container, label, isMe, sprite, color: jacket, back: false, lastX: person.x, lastY: person.y };
  }
  function ensureView(person, isMe) {
    let view = state.views.get(person.id);
    if (!view) { view = buildPersonView(person, isMe); state.views.set(person.id, view); }
    return view;
  }
  function placeMyView() {
    if (!state.scene) return;
    const view = ensureView(state.me, true);
    view.container.setPosition(state.me.x, state.me.y).setDepth(1000 + state.me.y);
  }
  function smoothPeers(delta) {
    const k = Math.min(1, delta / 140);
    state.peers.forEach((peer) => {
      const view = state.views.get(peer.id);
      if (!view) return;
      view.container.x += (peer.x - view.container.x) * k;
      view.container.y += (peer.y - view.container.y) * k;
      view.container.setDepth(1000 + view.container.y);
    });
  }
  // 걷는 동안 몸이 통통 튀고 살짝 기운다
  function animatePeople(time) {
    const Art = window.NatureArt;
    state.views.forEach((view) => {
      const dx = view.container.x - view.lastX; const dy = view.container.y - view.lastY;
      view.lastX = view.container.x; view.lastY = view.container.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.15) {
        view.stepping = time;
        if (Math.abs(dy) > Math.abs(dx) * 0.5) view.back = dy < 0; // 위로 걸으면 뒷모습
        if (Math.abs(dx) > 0.1) view.lean = dx > 0 ? 1 : -1;
      }
      const active = view.stepping !== undefined && time - view.stepping < 160;
      let key; let bob = 0; let angle = 0;
      if (active) {
        const cycle = 640; const t = ((time % cycle) / cycle) * Art.WALK_FRAMES; const frame = Math.floor(t) % Art.WALK_FRAMES;
        key = Art.characterKey(view.color, view.back, frame);
        const phase = (t / Art.WALK_FRAMES) * Math.PI * 2;
        bob = -Math.abs(Math.sin(phase)) * 3.5; // 발이 땅에 닿을 때 몸이 가장 낮아짐
        angle = (view.lean || 0) * 3 + Math.sin(phase) * 1.6;
      } else key = Art.characterKey(view.color, view.back, null);
      if (view.sprite.texture.key !== key) view.sprite.setTexture(key);
      view.sprite.y = 30 + bob; view.sprite.setAngle(angle);
    });
  }
  function removePeer(id) {
    state.peers.delete(id);
    state.lastReceived.delete(id);
    const view = state.views.get(id);
    if (view) { view.container.destroy(); state.views.delete(id); }
  }
  function redraw() {
    if (!state.scene) return;
    placeMyView();
    state.peers.forEach((peer) => {
      const view = ensureView(peer, false);
      void view;
    });
    state.hudDirty = true;
    renderHud();
  }

  // ---------- 화면 옆 안내(접속자, 위치) ----------
  function renderHud() {
    state.hudDirty = false;
    const everyone = [state.me, ...state.peers.values()];
    if (state.connected) {
      const live = state.mode === 'real' && state.realtime === 'live';
      elements.summary.textContent = state.mode === 'mock' ? '시험 모드예요. 나 혼자 있어요.' : (live ? `${everyone.length}명이 이 세계에 있어요.` : '친구들과 연결하는 중이에요.');
    } else { elements.summary.textContent = '아직 입장하지 않았어요.'; }
    elements.people.replaceChildren(...everyone.map((person) => { const item = document.createElement('li'); item.textContent = `${person.name}${person.id === myId ? ' (나)' : ''}`; return item; }));
    const zone = zoneAt(state.me); const waterNote = isWater(state.me) ? ' 물에서는 천천히 이동해요.' : '';
    const text = `${zone.name}: ${zone.hint}${waterNote}`;
    if (text !== state.lastZone) { elements.location.textContent = text; state.lastZone = text; }
  }

  // ---------- 위치 주고받기 ----------
  function currentPayload() { return { id: myId, name: state.me.name, color: state.me.color, x: Math.round(state.me.x), y: Math.round(state.me.y), seq: state.seq, timestamp: Date.now() }; }
  function acceptLocation(payload) {
    if (!payload || payload.id === myId || typeof payload.timestamp !== 'number') return;
    const old = state.lastReceived.get(payload.id) || 0;
    if (payload.timestamp <= old) return; // 순서가 뒤바뀐 오래된 메시지는 버림(보낸 사람 자신의 시계끼리만 비교)
    state.lastReceived.set(payload.id, payload.timestamp);
    const known = state.peers.get(payload.id);
    state.peers.set(payload.id, { ...(known || {}), id: payload.id, name: cleanName(payload.name) || `탐험가 ${String(payload.id).slice(-4)}`, color: payload.color, x: payload.x, y: payload.y, timestamp: payload.timestamp, receivedAt: Date.now() });
    if (!known) { redraw(); const view = state.views.get(payload.id); if (view) view.container.setPosition(payload.x, payload.y); }
    state.hudDirty = true;
  }
  function sendLocation() {
    const now = Date.now();
    if (now - state.lastSentAt < POSITION_INTERVAL) return;
    state.lastSentAt = now; state.seq += 1;
    if (state.mode !== 'real' || !state.channel || state.realtime !== 'live') return;
    state.channel.send({ type: 'broadcast', event: 'location', payload: currentPayload() });
  }
  // 접속 상태(Presence): 누가 들어오고 나갔는지만 반영한다. 이미 받은 최신 위치는 덮어쓰지 않는다.
  function applyPresence() {
    const snapshot = state.channel?.presenceState?.() || {};
    const present = new Set();
    Object.values(snapshot).flat().forEach((p) => {
      if (!p || !p.id || p.id === myId) return;
      present.add(p.id);
      if (!state.peers.has(p.id)) acceptLocation(p);
    });
    // 접속 상태가 위치 메시지보다 늦게 도착할 수 있어서, 한동안 위치를 못 받은 사람만 정리한다(나간 사람은 leave 이벤트가 바로 지운다).
    [...state.peers.values()].forEach((peer) => { if (!present.has(peer.id) && Date.now() - (peer.receivedAt || 0) > 10000) removePeer(peer.id); });
    state.hudDirty = true;
  }
  function setRealtime(status) {
    state.realtime = status;
    if (!elements.realtime) return;
    elements.realtime.textContent = status === 'live' ? '' : (status === 'down' ? '친구들의 움직임을 받지 못하고 있어요. 그래도 자연물은 함께 볼 수 있어요.' : '');
    state.hudDirty = true;
  }
  let presenceTimer = null;
  function subscribeReal() {
    state.channel = state.client.channel(CHANNEL_NAME, { config: { private: true, presence: { key: myId }, broadcast: { self: false, ack: false } } })
      .on('presence', { event: 'sync' }, applyPresence)
      .on('presence', { event: 'leave' }, ({ leftPresences }) => { (leftPresences || []).forEach((p) => { if (p && p.id) removePeer(p.id); }); state.hudDirty = true; })
      .on('broadcast', { event: 'location' }, ({ payload }) => acceptLocation(payload))
      .on('broadcast', { event: 'sync' }, () => { state.lastSentAt = 0; sendLocation(); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtime('live'); setStatus('입장했어요. 방향키로 걸어 보세요.');
          state.channel.track(currentPayload());
          state.channel.send({ type: 'broadcast', event: 'sync', payload: currentPayload() });
          applyPresence();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtime('down'); setStatus('친구들과의 연결이 불안정해요. 자동으로 다시 연결해요.');
        }
      });
    clearInterval(presenceTimer);
    presenceTimer = setInterval(() => { if (state.realtime === 'live') state.channel.track(currentPayload()); }, PRESENCE_REFRESH);
  }
  function leaveWorld() {
    clearInterval(presenceTimer);
    try { if (window.NaturePlacement) window.NaturePlacement.stop(); } catch (error) { /* 무시 */ }
    if (state.channel) { try { state.channel.untrack(); state.client?.removeChannel(state.channel); } catch (error) { /* 무시 */ } }
    state.channel = null; state.connected = false;
  }

  // ---------- 화면 전환과 입장 ----------
  function setJoinMessage(text, type = '') { elements.joinMessage.textContent = text; elements.joinMessage.dataset.type = type; }
  function showJoin(message) {
    elements.joinCard.hidden = false; elements.worldSection.hidden = true;
    setStatus('이름과 입장 코드를 입력해 주세요.');
    if (message) setJoinMessage(message);
    if (!elements.joinName.value) elements.joinName.value = savedName();
    (elements.joinName.value ? elements.joinCode : elements.joinName).focus();
  }
  function ensureGame() {
    if (state.gamePromise) return state.gamePromise;
    state.gamePromise = new Promise((resolve) => {
      state.resolveScene = resolve;
      state.phaser = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, backgroundColor: '#9dce8e', scene: NatureScene, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH } });
    });
    return state.gamePromise;
  }
  async function enterWorld(mode, userId, data, name) {
    myId = userId; session.setItem('nature-prototype-id', myId);
    const myName = cleanName(name) || savedName();
    if (myName) saveName(myName);
    state.mode = mode; state.me = makePerson(myId, myName); state.data = data;
    elements.joinCard.hidden = true; elements.worldSection.hidden = false;
    setStatus('자연 공간을 준비하고 있어요…');
    await ensureGame();
    state.me = makePerson(myId, myName);
    if (state.scene.anchor) state.scene.anchor.setPosition(state.me.x, state.me.y);
    state.connected = true;
    setRealtime(mode === 'real' ? 'connecting' : 'idle');
    if (mode === 'real') { setStatus('친구들과 연결하는 중이에요…'); subscribeReal(); } else { setStatus('시험 모드로 입장했어요. 서버와 연결하지 않아요.'); }
    window.NaturePlacement.start({ data, meId: myId, mode });
    redraw();
  }

  // 입장 코드 입력 칸: 쓰지 않는 글자는 서버로 보내기 전에 지운다(서버에 틀린 시도로 세지 않도록)
  function onCodeInput() {
    const { code, dropped } = R.normalizeCode(elements.joinCode.value);
    elements.joinCode.value = code;
    if (dropped) setJoinMessage('코드에 쓰지 않는 글자는 지웠어요. 헷갈리기 쉬운 0·O, 1·I, 2·Z, 5·S, 8·B는 코드에 없어요.');
  }
  function friendlyError(error) {
    const text = `${error?.message || ''} ${error?.code || ''} ${error?.status || ''}`;
    if (/429|rate limit|over_request|too many/i.test(text)) return '지금 접속하는 친구가 많아요. 잠시 뒤에 다시 해 보세요.';
    if (/fetch|network|load failed|timeout/i.test(text)) return '인터넷 연결을 확인해 주세요.';
    return '입장하지 못했어요. 잠시 뒤에 다시 해 보세요.';
  }
  // 저장된 로그인이 서버에서 사라졌을 수 있어서(getUser가 서버에 확인) 확인 후 필요하면 새로 익명 로그인한다.
  async function ensureUser() {
    const { data: current } = await state.client.auth.getSession();
    if (current && current.session) {
      const { data, error } = await state.client.auth.getUser();
      if (!error && data && data.user) return data.user;
      await state.client.auth.signOut();
    }
    const { data, error } = await state.client.auth.signInAnonymously();
    if (error || !data || !data.user) throw error || new Error('anonymous sign-in failed');
    return data.user;
  }
  async function onJoinSubmit(event) {
    event.preventDefault();
    if (state.joining || !state.client) return;
    const name = cleanName(elements.joinName.value);
    elements.joinName.value = name;
    const problem = nameProblem(name);
    if (problem) { setJoinMessage(problem, 'error'); elements.joinName.focus(); return; }
    const { code } = R.normalizeCode(elements.joinCode.value);
    if (code.length !== R.CODE_LENGTH) { setJoinMessage(`입장 코드는 ${R.CODE_LENGTH}자리예요. 다시 확인해 주세요.`, 'error'); elements.joinCode.focus(); return; }
    state.joining = true; elements.joinButton.disabled = true; setJoinMessage('확인하고 있어요…');
    try {
      const user = await ensureUser();
      const { data, error } = await state.client.rpc('join_class', { p_code: code });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      if (result && result.ok) { setJoinMessage(''); await enterWorld('real', user.id, D.createRealData(state.client, WORLD_ID), name); return; }
      const reason = result && result.reason;
      if (reason === 'invalid_code') setJoinMessage('코드가 맞지 않아요. 선생님이 알려 준 코드를 다시 확인해 주세요.', 'error');
      else if (reason === 'rate_limited') setJoinMessage('코드를 여러 번 틀렸어요. 10분쯤 뒤에 다시 해 보세요.', 'error');
      else if (reason === 'membership_revoked') setJoinMessage('이 학급에는 들어올 수 없어요. 선생님께 말씀드려 주세요.', 'error');
      else setJoinMessage('입장하지 못했어요. 선생님께 알려 주세요.', 'error');
    } catch (error) {
      setJoinMessage(friendlyError(error), 'error');
    } finally {
      state.joining = false; elements.joinButton.disabled = false;
    }
  }
  async function checkMembership(userId) {
    const { data, error } = await state.client.from('class_members').select('world_id').eq('world_id', WORLD_ID).eq('user_id', userId).is('revoked_at', null).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  }
  async function startReal() {
    const configured = CONFIG.supabaseUrl && CONFIG.supabasePublishableKey && !/^YOUR_/.test(CONFIG.supabaseUrl);
    if (!window.supabase || !configured) { showJoin(); setJoinMessage(DEV_MODE ? '시험용: Supabase 설정이 비어 있어요. 아래 버튼으로 서버 없이 입장할 수 있어요.' : '설정 파일(nature-config.js)을 확인해 주세요.', 'error'); elements.joinButton.disabled = true; return; }
    state.client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'nature-world-auth' } });
    try {
      const { data } = await state.client.auth.getSession();
      if (data && data.session && await checkMembership(data.session.user.id)) { await enterWorld('real', data.session.user.id, D.createRealData(state.client, WORLD_ID)); return; }
    } catch (error) { /* 저장된 로그인으로 못 들어가면 코드 입력으로 */ }
    showJoin();
  }
  async function enterDev() {
    const data = D.createMockData({ meId: myId, worldId: WORLD_ID });
    data._addFriend({ owner_id: 'friend-min', kind: 'shrub', x: 640, y: 520 });
    data._addFriend({ owner_id: 'friend-jun', kind: 'fallen_branch', x: 820, y: 980 });
    await enterWorld('mock', myId, data, cleanName(elements.joinName.value));
  }

  window.addEventListener('load', () => {
    elements.joinForm.addEventListener('submit', onJoinSubmit);
    elements.joinCode.addEventListener('input', onCodeInput);
    elements.devEnter.hidden = !DEV_MODE;
    elements.devEnter.addEventListener('click', enterDev);
    if (DEV_MODE || params.get('debug') === '1') window.__nature = { state, game };
    startReal();
  });
  window.addEventListener('pagehide', leaveWorld);
})();
