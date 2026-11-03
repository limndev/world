/*
 * 월드 지형과 자연물 설치 규칙 (브라우저와 Node 테스트에서 같이 씁니다).
 *
 * 서버(supabase/migrations/0002)가 판단하는 규칙: 월드 경계, 종류, 개수, 속도, 자연물끼리 겹침.
 * 서버가 판단하지 않는 규칙(이 파일이 클라이언트에서만 막음): 물, 길, 기존 나무·돌 같은 장식.
 * 그래서 아래 KINDS의 radius는 0002 SQL의 겹침 반경과 반드시 같아야 합니다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NatureRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORLD_WIDTH = 2400;
  const WORLD_HEIGHT = 1500;
  const PER_USER_LIMIT = 12;
  const WORLD_LIMIT = 300;
  const WRITE_INTERVAL_MS = 2000;

  // 지형 데이터 (게임 화면이 쓰는 값과 같은 것)
  const ZONES = [
    { id: 'meadow', name: '열린 초원', kind: 'land', x: 180, y: 160, width: 1120, height: 850, hint: '넓은 풀밭에서 다른 탐험가와 천천히 걸어 볼 수 있어요.' },
    { id: 'pond', name: '연못과 물의 정원', kind: 'water', x: 1320, y: 260, width: 670, height: 510, hint: '물가에서는 걸음이 느려져 물의 결을 느낄 수 있어요.' },
    { id: 'reedbed', name: '갈대밭과 습지', kind: 'wetland', x: 1770, y: 820, width: 470, height: 420, hint: '갈대가 바람에 흔들리는 낮은 습지예요.' },
    { id: 'island', name: '작은 섬', kind: 'land', x: 1510, y: 410, width: 190, height: 145, hint: '물길 사이의 작은 섬에서 잠시 머물러 보세요.' },
    { id: 'field', name: '바람 드는 들판', kind: 'land', x: 380, y: 1090, width: 1260, height: 280, hint: '길게 열린 들판에는 바람의 방향이 보이는 풀이 있어요.' },
    { id: 'quiet', name: '조용한 나무 그늘', kind: 'quiet', x: 170, y: 1030, width: 260, height: 260, hint: '자극이 적은 작은 쉼터예요. 잠시 멈춰 있어도 괜찮아요.' }
  ];
  const WATER_AREAS = [
    { x: 1280, y: 215, width: 760, height: 620 },
    { x: 870, y: 745, width: 780, height: 150 },
    { x: 1570, y: 760, width: 170, height: 450 }
  ];
  // 갈대밭 안의 얕은 물 (화면에 청록색으로 그려지는 부분)
  const SHALLOWS = [{ x: 1810, y: 894, width: 350, height: 200 }];
  // 작은 섬 (물 한가운데 있는 땅)
  const ISLAND = { cx: 1605, cy: 480, rx: 115, ry: 82 };

  // 설치 가능한 자연물. radius는 0002 SQL의 겹침 반경과 같아야 한다(서버가 최종 판단).
  // displayWidth는 화면에 그리는 너비입니다. 일부러 겹침 반경보다 크게 그려 풍성해 보이게 합니다.
  const KINDS = {
    rock: { label: '돌', radius: 34, texture: 'mossyRocks', displayWidth: 92, hint: '이끼 낀 돌이에요.' },
    wildflower: { label: '야생화', radius: 26, texture: 'wildflowerPatch', displayWidth: 104, hint: '작은 꽃이 피는 풀밭이에요.' },
    shrub: { label: '관목', radius: 70, texture: 'shrubFlower', displayWidth: 150, hint: '꽃이 핀 둥근 덤불이에요.' },
    fallen_branch: { label: '쓰러진 나뭇가지', radius: 42, texture: 'fallenBranch', displayWidth: 112, hint: '땅에 떨어진 기다란 나뭇가지예요.' }
  };
  const KIND_ORDER = ['rock', 'wildflower', 'shrub', 'fallen_branch'];

  // 이미 그려져 있는 나무·덤불·돌 (그 위에 겹쳐 놓지 못하게 막는다)
  const STATIC_BLOCKERS = [
    { x: 225, y: 205, r: 46 }, { x: 1050, y: 260, r: 42 }, { x: 1080, y: 672, r: 46 },
    { x: 1450, y: 990, r: 52 }, { x: 2180, y: 1120, r: 50 }, { x: 2140, y: 640, r: 48 },
    { x: 1125, y: 575, r: 56 }, { x: 920, y: 700, r: 48 },
    { x: 1940, y: 1190, r: 48 }, { x: 2050, y: 840, r: 48 }, { x: 1320, y: 1070, r: 48 },
    { x: 360, y: 445, r: 48 }, { x: 675, y: 325, r: 40 }, { x: 1010, y: 555, r: 46 },
    { x: 1165, y: 680, r: 42 }, { x: 1260, y: 340, r: 36 },
    { x: 650, y: 1290, r: 30 }, { x: 1440, y: 1320, r: 30 },
    { x: 300, y: 1190, r: 60 } // 조용한 나무 그늘의 벤치
  ];

  // ---------- 기본 도형 판정 ----------
  function inArea(point, area) {
    return point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height;
  }
  function zoneAt(point) { return [...ZONES].reverse().find((zone) => inArea(point, zone)) || ZONES[0]; }
  // 이동 속도용 물 판정 (게임 이동 로직이 쓰는 것과 같음)
  function isWater(point) { return zoneAt(point).id !== 'island' && WATER_AREAS.some((area) => inArea(point, area)); }

  function inflate(area, m) { return { x: area.x - m, y: area.y - m, width: area.width + 2 * m, height: area.height + 2 * m }; }

  // ---------- 길 ----------
  // 초원 지형 그림(meadow-terrain.svg)의 흙길: 위·아래 곡선을 SVG 경로 그대로 따와서 월드 좌표(+100,+95)로 옮김
  function bezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
      x: u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      y: u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    };
  }
  function meadowPathPolygon(margin) {
    const OX = 100, OY = 95, steps = 28, poly = [];
    for (let i = 0; i <= steps; i += 1) {
      const p = bezier([0, 728], [284, 654], [735, 669], [1240, 741], i / steps);
      poly.push([p.x + OX, p.y + OY - margin]);
    }
    for (let i = 0; i <= steps; i += 1) {
      const p = bezier([1240, 811], [785, 746], [343, 739], [0, 806], i / steps);
      poly.push([p.x + OX, p.y + OY + margin]);
    }
    return poly;
  }
  function inPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const FIELD_PATH = { x: 505, y: 1164, width: 1040, height: 42 }; // 들판의 흙길
  const pathPolygonCache = new Map();
  function pathPolygon(margin) {
    if (!pathPolygonCache.has(margin)) pathPolygonCache.set(margin, meadowPathPolygon(margin));
    return pathPolygonCache.get(margin);
  }

  // ---------- 땅 규칙 (물·길·장식) ----------
  // 자연물 하나를 놓을 수 있는 땅인지. 통과하면 null, 막히면 이유('bounds'|'water'|'path'|'decor')를 돌려준다.
  function groundBlock(kind, x, y) {
    const info = KINDS[kind];
    const r = info ? info.radius : 30;
    if (x < 40 || x > WORLD_WIDTH - 40 || y < 70 || y > WORLD_HEIGHT - 40) return 'bounds';
    const point = { x, y };
    // 섬 안에서는 발자국 전체가 섬 땅에 들어올 때만 허용
    const onIslandZone = inArea(point, ZONES.find((z) => z.id === 'island'));
    const fit = 0.8;
    const ax = ISLAND.rx - r * fit, ay = ISLAND.ry - r * fit;
    const insideIsland = ax > 0 && ay > 0 && ((x - ISLAND.cx) / ax) ** 2 + ((y - ISLAND.cy) / ay) ** 2 <= 1;
    const margin = r * 0.5;
    const inWater = WATER_AREAS.some((a) => inArea(point, inflate(a, margin))) || SHALLOWS.some((a) => inArea(point, inflate(a, margin)));
    if (insideIsland) { /* 섬 위: 물 판정 건너뜀 */ } else if (inWater || onIslandZone) return 'water';
    const m = Math.min(24, r * 0.5);
    if (inPolygon(x, y, pathPolygon(m)) || inArea(point, inflate(FIELD_PATH, m))) return 'path';
    if (STATIC_BLOCKERS.some((b) => Math.hypot(b.x - x, b.y - y) < r + b.r)) return 'decor';
    return null;
  }

  // ---------- 자연물끼리 겹침 (서버 규칙과 같은 식) ----------
  function overlapsOthers(kind, x, y, objects, ignoreId) {
    const r = KINDS[kind].radius;
    for (const o of objects) {
      if (o.id === ignoreId || o.deleted_at) continue;
      const other = KINDS[o.kind];
      if (!other) continue;
      if (Math.hypot(o.x - x, o.y - y) < r + other.radius * (o.scale || 1)) return true;
    }
    return false;
  }

  // ---------- 안내 문구 ----------
  function hasBatchim(word) {
    const ch = word.charCodeAt(word.length - 1);
    if (ch < 0xac00 || ch > 0xd7a3) return false;
    return (ch - 0xac00) % 28 !== 0;
  }
  function eul(word) { return word + (hasBatchim(word) ? '을' : '를'); }
  function iyeyo(word) { return word + (hasBatchim(word) ? '이에요' : '예요'); }

  const BLOCK_MESSAGES = {
    bounds: '월드 안쪽을 골라 주세요.',
    water: '물 위에는 놓을 수 없어요. 풀밭을 골라 주세요.',
    path: '길 위에는 놓을 수 없어요. 길 옆 풀밭을 골라 주세요.',
    decor: '나무나 덤불 가까이에는 놓을 수 없어요. 조금 떨어진 곳을 골라 주세요.',
    overlap: '다른 자연물과 너무 가까워요. 조금 떨어진 곳을 골라 주세요.'
  };

  // 후보 위치 검사: { ok, reason, message }
  function validate(kind, x, y, objects, ignoreId) {
    if (!KINDS[kind]) return { ok: false, reason: 'kind', message: '고를 수 없는 자연물이에요.' };
    const block = groundBlock(kind, x, y);
    if (block) return { ok: false, reason: block, message: BLOCK_MESSAGES[block] };
    if (overlapsOthers(kind, x, y, objects, ignoreId)) return { ok: false, reason: 'overlap', message: BLOCK_MESSAGES.overlap };
    return { ok: true, reason: null, message: '여기에 놓을 수 있어요.' };
  }

  // 서버(0002 SQL) 오류 문구 → 학생에게 보여 줄 말
  const SERVER_ERRORS = {
    'nature object overlaps another object': BLOCK_MESSAGES.overlap,
    'world nature object limit reached': '월드에 자연물이 가득 찼어요. 선생님께 알려 주세요.',
    'owner nature object limit reached': `내 자연물은 ${PER_USER_LIMIT}개까지 놓을 수 있어요. 하나를 지우고 다시 해 보세요.`,
    'nature object write rate exceeded': '잠깐만 쉬었다가 다시 해 보세요.',
    'stale nature object version': '친구가 먼저 바꿨어요. 다시 골라 보세요.',
    'active class membership required': '이 학급에 들어온 뒤에 할 수 있어요. 입장 코드를 다시 확인해 주세요.',
    'authentication required': '로그인이 풀렸어요. 화면을 새로고침해 주세요.',
    'world bounds exceeded': BLOCK_MESSAGES.bounds,
    'unsupported nature object kind': '고를 수 없는 자연물이에요.',
    'nature object not found': '이미 사라졌거나 내 자연물이 아니에요.'
  };
  function serverErrorMessage(error) {
    const raw = (error && (error.serverMessage || error.message)) || '';
    const key = Object.keys(SERVER_ERRORS).find((k) => raw.includes(k));
    if (key) return SERVER_ERRORS[key];
    if (/fetch|network|failed to fetch|load failed/i.test(raw)) return '인터넷 연결을 확인해 주세요.';
    return '지금은 할 수 없어요. 잠시 뒤에 다시 해 보세요.';
  }

  // 입장 코드: 서버가 허용하는 글자(0002 SQL: ^[A-HJ-NP-Z2-9]{8}$) 중에서도 헷갈리는 글자를 뺀 26자만 쓴다.
  const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';
  const CODE_LENGTH = 8;
  function normalizeCode(raw) {
    const upper = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
    let clean = '';
    let dropped = false;
    for (const ch of upper) {
      if (CODE_ALPHABET.includes(ch)) clean += ch; else dropped = true;
    }
    return { code: clean.slice(0, CODE_LENGTH), dropped: dropped || clean.length > CODE_LENGTH };
  }

  return {
    WORLD_WIDTH, WORLD_HEIGHT, PER_USER_LIMIT, WORLD_LIMIT, WRITE_INTERVAL_MS,
    ZONES, WATER_AREAS, SHALLOWS, ISLAND, KINDS, KIND_ORDER, STATIC_BLOCKERS, FIELD_PATH, CODE_ALPHABET, CODE_LENGTH,
    inArea, zoneAt, isWater, groundBlock, overlapsOthers, validate, eul, iyeyo, serverErrorMessage, normalizeCode,
    pathPolygon
  };
});
