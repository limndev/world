// 실행: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../placement-rules.js');
const D = require('../data.js');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0004_more_nature_kinds_and_codes.sql'), 'utf8');

test('겹침 반경이 서버 SQL(0004)의 nature_kind_radius와 모든 종류에서 같다', () => {
  const body = sql.match(/function public\.nature_kind_radius[\s\S]*?\$\$;/)[0];
  const table = {};
  for (const m of body.matchAll(/when '(\w+)' then (\d+)/g)) table[m[1]] = Number(m[2]);
  assert.deepStrictEqual(Object.keys(table).sort(), Object.keys(R.KINDS).sort(), '종류 목록이 같아야 한다');
  for (const [kind, info] of Object.entries(R.KINDS)) assert.strictEqual(table[kind], info.radius, kind);
  const check = sql.match(/add constraint nature_objects_kind_check check \(kind in \(([\s\S]*?)\)\)/)[1];
  assert.deepStrictEqual([...check.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort(), Object.keys(R.KINDS).sort(), '허용 종류 목록이 같아야 한다');
});

test('고르는 버튼은 12종이고 모두 규칙·그림 이름이 있다', () => {
  assert.strictEqual(R.KIND_ORDER.length, 12);
  for (const k of R.KIND_ORDER) { assert.ok(R.KINDS[k], k); assert.ok(R.KINDS[k].texture && R.KINDS[k].displayWidth && R.KINDS[k].label, k); }
  assert.ok(!R.KIND_ORDER.includes('fallen_branch'));
  assert.ok(!Object.values(R.KINDS).some((k) => k.label === '관목'), '어려운 말 "관목"은 쓰지 않는다');
  const art = fs.readFileSync(path.join(__dirname, '../art.js'), 'utf8');
  for (const k of Object.values(R.KINDS)) assert.ok(art.includes(`'${k.texture}'`), `art.js에 ${k.texture} 그림이 없다`);
});

test('벌집을 달 나무 위치는 art.js의 나무·막힘 목록과 같다', () => {
  const art = fs.readFileSync(path.join(__dirname, '../art.js'), 'utf8');
  const trees = [...art.matchAll(/\['tree\d', (\d+), (\d+),/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  assert.deepStrictEqual(R.TREES, trees);
  assert.deepStrictEqual(R.STATIC_BLOCKERS.slice(0, 6).map((b) => ({ x: b.x, y: b.y })), trees);
});

test('입장 코드 글자는 서버 정규식 ^[A-HJ-NP-Z2-9]{8}$ 의 부분집합이다', () => {
  assert.strictEqual(R.CODE_ALPHABET.length, 26);
  for (const ch of R.CODE_ALPHABET) assert.match(ch, /^[A-HJ-NP-Z2-9]$/);
  for (const bad of 'IO01S5B8Z2') assert.ok(!R.CODE_ALPHABET.includes(bad), bad);
});

test('입장 코드 입력 정리: 소문자·공백·하이픈 처리, 헷갈리는 글자 제거, 8자 제한', () => {
  assert.deepStrictEqual(R.normalizeCode(' ac4d-7k9m '), { code: 'AC4D7K9M', dropped: false });
  const r = R.normalizeCode('AC4D7K9M0O1I');
  assert.strictEqual(r.code, 'AC4D7K9M'); assert.ok(r.dropped);
  assert.strictEqual(R.normalizeCode('가나다ABC').code, 'AC');
  assert.strictEqual(R.normalizeCode('').code, '');
});

test('조사: 받침에 따라 을/를, 이에요/예요', () => {
  assert.strictEqual(R.eul('돌'), '돌을'); assert.strictEqual(R.eul('꽃'), '꽃을');
  assert.strictEqual(R.eul('작은 나무'), '작은 나무를'); assert.strictEqual(R.eul('다람쥐'), '다람쥐를'); assert.strictEqual(R.eul('벌집'), '벌집을');
  assert.strictEqual(R.iyeyo('돌'), '돌이에요'); assert.strictEqual(R.iyeyo('토끼'), '토끼예요');
});

test('땅 규칙: 물·길·장식·경계', () => {
  assert.strictEqual(R.groundBlock('rock', 1600, 600), 'water'); // 연못 한가운데
  assert.strictEqual(R.groundBlock('rock', 1000, 800), 'water'); // 물길
  assert.strictEqual(R.groundBlock('wildflower', 1880, 980), 'water'); // 갈대밭 얕은 물
  assert.strictEqual(R.groundBlock('rock', 600, 850), 'path'); // 초원 흙길
  assert.strictEqual(R.groundBlock('rock', 700, 1185), 'path'); // 들판 흙길
  assert.strictEqual(R.groundBlock('rock', 225, 205), 'decor'); // 나무 위
  assert.strictEqual(R.groundBlock('rock', 10, 500), 'bounds');
  assert.strictEqual(R.groundBlock('rock', 640, 520), null); // 풀밭
});

test('작은 섬: 작은 놓은 것은 섬 가운데에 놓을 수 있고, 큰 관목은 놓을 수 없다', () => {
  assert.strictEqual(R.groundBlock('wildflower', 1605, 480), null);
  assert.strictEqual(R.groundBlock('rock', 1605, 480), null);
  assert.strictEqual(R.groundBlock('shrub', 1605, 480), null); // 관목(너비 150)은 섬(안쪽 땅 178)에 겨우 들어간다
  assert.strictEqual(R.groundBlock('shrub', 1685, 480), 'water'); // 섬 가운데에서 벗어나면 막힘
  assert.strictEqual(R.groundBlock('wildflower', 1700, 480), 'water'); // 섬 가장자리 밖
});

test('겹침 판정은 서버와 같은 식(중심 거리 < 반경 합)', () => {
  const other = [{ id: 'a', kind: 'rock', x: 640, y: 520, scale: 1 }];
  assert.strictEqual(R.validate('rock', 640 + 68, 520, other).ok, true); // 거리 68 = 반경 합 34+34 → 겹치지 않음(서버는 < 로 판정)
  assert.strictEqual(R.validate('rock', 640 + 67, 520, other).reason, 'overlap');
  assert.strictEqual(R.validate('rock', 640 + 60, 520, other).reason, 'overlap');
  assert.strictEqual(R.validate('shrub', 640 + 90, 520, other).reason, 'overlap'); // 70+34=104
  assert.strictEqual(R.validate('shrub', 640 + 110, 520, other).ok, true);
  assert.strictEqual(R.validate('rock', 640, 520, other, 'a').ok, true); // 자기 자신은 제외(옮기기)
  assert.strictEqual(R.validate('rock', 640, 520, [{ ...other[0], deleted_at: 'x' }]).ok, true); // 지운 것은 무시
});

test('서버 오류 문구를 학생용 말로 바꾼다', () => {
  assert.match(R.serverErrorMessage({ serverMessage: 'nature object overlaps another object' }), /가까워요/);
  assert.match(R.serverErrorMessage({ message: 'owner nature object limit reached' }), /12개/);
  assert.match(R.serverErrorMessage({ message: 'Failed to fetch' }), /인터넷/);
  assert.match(R.serverErrorMessage({ message: 'something else' }), /잠시/);
});

test('시험용 데이터(mock)가 서버 규칙을 같은 문구로 흉내 낸다', async () => {
  let t = 1000;
  const d = D.createMockData({ meId: 'me', now: () => t });
  const a = await d.create({ kind: 'rock', x: 640, y: 520 });
  assert.strictEqual(a.version, 1);
  await assert.rejects(() => d.create({ kind: 'rock', x: 900, y: 520 }), /write rate exceeded/);
  t += 2100;
  await assert.rejects(() => d.create({ kind: 'rock', x: 650, y: 520 }), /overlaps/);
  // 실패한 시도는 속도 제한을 소모하지 않는다(서버 롤백과 같음) → 바로 다시 성공 가능
  const b = await d.create({ kind: 'rock', x: 900, y: 520 });
  assert.ok(b.id);
  t += 2100;
  await assert.rejects(() => d.move({ id: a.id, x: 700, y: 520, expectedVersion: 5 }), /stale/);
  const moved = await d.move({ id: a.id, x: 760, y: 520, expectedVersion: 1 });
  assert.strictEqual(moved.version, 2);
  t += 2100;
  const friend = d._addFriend({ kind: 'shrub', x: 1000, y: 900 });
  await assert.rejects(() => d.remove({ id: friend.id, expectedVersion: 1 }), /not found/);
  const removed = await d.remove({ id: a.id, expectedVersion: 2 });
  assert.ok(removed.deleted_at);
  assert.strictEqual((await d.list()).some((o) => o.id === a.id), false);
});

test('개수 상한: 내 12개, 월드 300개', async () => {
  let t = 0;
  const d = D.createMockData({ meId: 'me', now: () => t });
  for (let i = 0; i < 12; i += 1) { t += 2100; await d.create({ kind: 'wildflower', x: 100 + (i % 6) * 100, y: 100 + Math.floor(i / 6) * 100 }); }
  t += 2100;
  await assert.rejects(() => d.create({ kind: 'wildflower', x: 1000, y: 1000 }), /owner nature object limit/);
});

test('벌집은 나무에만: 나무 근처(잎 쪽 포함)를 누르면 나무 뿌리 자리로 붙고, 먼 곳은 막힌다', () => {
  const t = R.TREES[0]; // (225, 205)
  const near = R.validate('beehive', t.x + 40, t.y + 20, []);
  assert.deepStrictEqual([near.ok, near.x, near.y], [true, t.x, t.y]);
  const leaves = R.validate('beehive', t.x - 30, t.y - 150, []); // 잎 쪽
  assert.deepStrictEqual([leaves.ok, leaves.x, leaves.y], [true, t.x, t.y]);
  const far = R.validate('beehive', 640, 520, []);
  assert.strictEqual(far.ok, false); assert.strictEqual(far.reason, 'tree'); assert.match(far.message, /나무에만/);
  const taken = R.validate('beehive', t.x, t.y, [{ id: 'h', kind: 'beehive', x: t.x, y: t.y, scale: 1 }]);
  assert.strictEqual(taken.ok, false); assert.match(taken.message, /이미 있어요/);
  assert.strictEqual(R.validate('beehive', R.TREES[1].x, R.TREES[1].y, [{ id: 'h', kind: 'beehive', x: t.x, y: t.y, scale: 1 }]).ok, true, '다른 나무에는 달 수 있다');
});

test('물고기·수련은 물 위에만: 큰 연못, 얕은 물, 놓아 둔 작은 연못 안', () => {
  for (const kind of ['fish', 'waterlily']) {
    assert.strictEqual(R.validate(kind, 640, 520, []).reason, 'notwater', `${kind} 풀밭`);
    assert.strictEqual(R.validate(kind, 1500, 300, []).ok, true, `${kind} 큰 연못`);
    assert.strictEqual(R.validate(kind, 1880, 980, []).ok, true, `${kind} 갈대밭 얕은 물`);
    assert.strictEqual(R.validate(kind, 1605, 480, []).reason, 'notwater', `${kind} 작은 섬 위`);
    assert.strictEqual(R.validate(kind, 1285, 220, []).ok, false, `${kind} 물가 가장자리(그림이 물 밖으로 삐져나옴)`);
  }
  assert.strictEqual(R.validate('fish', 1400, 330, []).reason, 'waterdecor', '갈대·연잎 위는 막는다');
  const pond = { id: 'p', kind: 'pond', x: 640, y: 520, scale: 1 };
  assert.strictEqual(R.validate('fish', 640, 520, [pond]).ok, true, '작은 연못 안 물고기');
  assert.strictEqual(R.validate('waterlily', 640 + 30, 520, [pond]).ok, true);
  assert.strictEqual(R.validate('fish', 640 + 75, 520, [pond]).reason, 'notwater', '연못 가장자리 밖');
  assert.strictEqual(R.validate('fish', 640, 520, [{ ...pond, deleted_at: 'x' }]).reason, 'notwater', '지운 연못은 물이 아니다');
});

test('작은 연못: 풀밭에만, 안의 물고기·수련과는 겹쳐도 되고 다른 것과는 안 된다', () => {
  assert.strictEqual(R.validate('pond', 640, 520, []).ok, true);
  assert.strictEqual(R.validate('pond', 1600, 600, []).reason, 'water');
  assert.strictEqual(R.validate('pond', 600, 850, []).reason, 'path');
  const pond = { id: 'p', kind: 'pond', x: 640, y: 520, scale: 1 };
  assert.strictEqual(R.overlapExempt('pond', 'fish'), true); assert.strictEqual(R.overlapExempt('waterlily', 'pond'), true);
  assert.strictEqual(R.overlapExempt('pond', 'rock'), false); assert.strictEqual(R.overlapExempt('fish', 'fish'), false);
  assert.strictEqual(R.validate('rock', 640, 520, [pond]).reason, 'overlap');
  assert.strictEqual(R.validate('pond', 640 + 100, 520, [pond]).reason, 'overlap');
  assert.strictEqual(R.validate('fish', 640, 520, [pond, { id: 'f', kind: 'fish', x: 640, y: 520, scale: 1 }]).reason, 'overlap', '같은 자리 물고기 둘은 안 된다');
});

test('나비·다람쥐·토끼·갈대·덩굴은 풀밭에 놓을 수 있고 물 위에는 못 놓는다', () => {
  for (const kind of ['butterfly', 'squirrel', 'rabbit', 'reed', 'vine']) {
    assert.strictEqual(R.validate(kind, 640, 520, []).ok, true, kind);
    assert.strictEqual(R.validate(kind, 1600, 600, []).reason, 'water', kind);
  }
});
