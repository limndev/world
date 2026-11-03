/*
 * 자연물 데이터 계층. 화면 코드는 이 파일의 두 구현을 같은 방식으로 씁니다.
 *   - createRealData: 실제 Supabase (RPC로 쓰고, 테이블 읽기 + Postgres Changes + 주기적 새로 읽기로 받음)
 *   - createMockData: 서버 없이 시험하는 메모리 구현. 서버 규칙(0002 SQL)을 같은 문구로 흉내 냄.
 * 쓰기(create/move/remove)는 성공하면 서버가 돌려준 행(row)을 반환하고, 실패하면 Error(serverMessage)를 던집니다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./placement-rules.js'));
  else root.NatureData = factory(root.NatureRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const POLL_INTERVAL_MS = 5000;

  function normalize(row) {
    if (!row) return row;
    return {
      id: row.id, world_id: row.world_id, owner_id: row.owner_id, kind: row.kind,
      x: Number(row.x), y: Number(row.y), rotation: Number(row.rotation || 0), scale: Number(row.scale || 1),
      version: Number(row.version || 1), deleted_at: row.deleted_at || null
    };
  }
  function serverError(message, code) {
    const e = new Error(message);
    e.serverMessage = message;
    if (code) e.code = code;
    return e;
  }

  // ---------------- 실제 Supabase ----------------
  function createRealData(client, worldId) {
    const api = {
      kind: 'real',
      lastWriteAt: 0,
      async call(fn, args) {
        const { data, error } = await client.rpc(fn, args);
        if (error) throw serverError(error.message || 'rpc error', error.code);
        const row = normalize(Array.isArray(data) ? data[0] : data);
        api.lastWriteAt = Date.now();
        return row;
      },
      async list() {
        const { data, error } = await client.from('nature_objects').select('*').eq('world_id', worldId).is('deleted_at', null);
        if (error) throw serverError(error.message || 'select error', error.code);
        return (data || []).map(normalize);
      },
      create({ kind, x, y, rotation = 0, scale = 1 }) {
        return api.call('create_nature_object', { p_world_id: worldId, p_kind: kind, p_x: x, p_y: y, p_rotation: rotation, p_scale: scale });
      },
      move({ id, x, y, expectedVersion, rotation = 0 }) {
        return api.call('move_nature_object', { p_object_id: id, p_x: x, p_y: y, p_expected_version: expectedVersion, p_rotation: rotation });
      },
      remove({ id, expectedVersion }) {
        return api.call('delete_nature_object', { p_object_id: id, p_expected_version: expectedVersion });
      },
      // onEvent({type:'upsert'|'remove'|'snapshot', ...}), onStatus('live'|'polling-only')
      subscribe(onEvent, onStatus) {
        let channel = null;
        let timer = null;
        let stopped = false;
        let live = false;
        try {
          channel = client.channel(`db-nature-objects:${worldId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'nature_objects', filter: `world_id=eq.${worldId}` }, (payload) => {
              if (stopped) return;
              if (payload.eventType === 'DELETE') onEvent({ type: 'remove', id: payload.old && payload.old.id });
              else if (payload.new) onEvent({ type: 'upsert', row: normalize(payload.new) });
            })
            .subscribe((status) => {
              const nowLive = status === 'SUBSCRIBED';
              if (nowLive !== live) { live = nowLive; if (onStatus) onStatus(live ? 'live' : 'polling-only'); }
            });
        } catch (error) {
          if (onStatus) onStatus('polling-only');
        }
        // 실시간 알림이 늦거나 끊겨도 5초 안에 맞춰지도록 주기적으로 전체를 다시 읽는다.
        const poll = async () => {
          if (stopped) return;
          const startedAt = Date.now();
          try { onEvent({ type: 'snapshot', rows: await api.list(), startedAt }); } catch (error) { /* 다음 주기에 다시 */ }
        };
        timer = setInterval(poll, POLL_INTERVAL_MS);
        poll();
        return () => {
          stopped = true;
          clearInterval(timer);
          if (channel) client.removeChannel(channel);
        };
      }
    };
    return api;
  }

  // ---------------- 서버 없이 시험 (메모리) ----------------
  function createMockData({ meId, worldId = 'nature-prototype', now = () => Date.now() }) {
    const objects = [];
    const listeners = new Set();
    let seq = 1;
    let lastWrite = -Infinity;
    const active = () => objects.filter((o) => !o.deleted_at);
    const emit = (event) => listeners.forEach((fn) => fn(event));
    const fail = (message) => { throw serverError(message); };
    const copy = (row) => ({ ...row });

    function checkCommon(kind, x, y, ignoreId) {
      if (!R.KINDS[kind]) fail('unsupported nature object kind');
      if (!(x >= 0 && x <= 2399 && y >= 0 && y <= 1499)) fail('world bounds exceeded');
      if (R.overlapsOthers(kind, x, y, active(), ignoreId)) fail('nature object overlaps another object');
    }
    // 서버처럼: 속도 검사를 먼저 하고, 다른 검사가 실패하면 속도 기록을 남기지 않는다(트랜잭션 롤백).
    function rateOk() { if (now() - lastWrite < R.WRITE_INTERVAL_MS) fail('nature object write rate exceeded'); }

    const api = {
      kind: 'mock',
      lastWriteAt: 0,
      objects,
      async list() { return active().map(copy); },
      async create({ kind, x, y, rotation = 0, scale = 1 }) {
        rateOk();
        if (active().length >= R.WORLD_LIMIT) fail('world nature object limit reached');
        if (active().filter((o) => o.owner_id === meId).length >= R.PER_USER_LIMIT) fail('owner nature object limit reached');
        checkCommon(kind, x, y);
        const row = { id: `mock-${seq++}`, world_id: worldId, owner_id: meId, kind, x, y, rotation, scale, version: 1, deleted_at: null };
        objects.push(row);
        lastWrite = now(); api.lastWriteAt = Date.now();
        emit({ type: 'upsert', row: copy(row) });
        return copy(row);
      },
      async move({ id, x, y, expectedVersion, rotation = 0 }) {
        rateOk();
        const row = active().find((o) => o.id === id && o.owner_id === meId);
        if (!row) fail('nature object not found');
        if (row.version !== expectedVersion) fail('stale nature object version');
        checkCommon(row.kind, x, y, id);
        Object.assign(row, { x, y, rotation, version: row.version + 1 });
        lastWrite = now(); api.lastWriteAt = Date.now();
        emit({ type: 'upsert', row: copy(row) });
        return copy(row);
      },
      async remove({ id, expectedVersion }) {
        rateOk();
        const row = active().find((o) => o.id === id && o.owner_id === meId);
        if (!row) fail('nature object not found');
        if (row.version !== expectedVersion) fail('stale nature object version');
        row.deleted_at = new Date().toISOString(); row.version += 1;
        lastWrite = now(); api.lastWriteAt = Date.now();
        emit({ type: 'upsert', row: copy(row) });
        return copy(row);
      },
      subscribe(onEvent, onStatus) {
        listeners.add(onEvent);
        if (onStatus) onStatus('mock');
        return () => listeners.delete(onEvent);
      },
      // 시험용: 다른 학생이 놓은 것처럼 행을 넣는다.
      _addFriend(row) {
        const full = { id: `friend-${seq++}`, world_id: worldId, owner_id: 'friend-user', rotation: 0, scale: 1, version: 1, deleted_at: null, ...row };
        objects.push(full);
        emit({ type: 'upsert', row: copy(full) });
        return copy(full);
      },
      _setLastWrite(ms) { lastWrite = ms; }
    };
    return api;
  }

  return { createRealData, createMockData, normalize, POLL_INTERVAL_MS };
});
