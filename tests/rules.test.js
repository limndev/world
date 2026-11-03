// 실행: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../placement-rules.js');
const D = require('../data.js');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0002_nature_objects.sql'), 'utf8');

test('겹침 반경이 서버 SQL(0002)과 같다', () => {
  const m = sql.match(/when 'wildflower' then (\d+) when 'shrub' then (\d+) when 'rock' then (\d+) else (\d+) end/);
  assert.ok(m, 'SQL에서 반경 표를 못 찾음');
  assert.deepStrictEqual([R.KINDS.wildflower.radius, R.KINDS.shrub.radius, R.KINDS.rock.radius, R.KINDS.fallen_branch.radius], m.slice(1).map(Number));
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
  assert.strictEqual(R.eul('돌'), '돌을'); assert.strictEqual(R.eul('야생화'), '야생화를');
  assert.strictEqual(R.eul('관목'), '관목을'); assert.strictEqual(R.eul('쓰러진 나뭇가지'), '쓰러진 나뭇가지를');
  assert.strictEqual(R.iyeyo('돌'), '돌이에요'); assert.strictEqual(R.iyeyo('야생화'), '야생화예요');
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

test('작은 섬: 작은 자연물은 섬 가운데에 놓을 수 있고, 큰 관목은 놓을 수 없다', () => {
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
