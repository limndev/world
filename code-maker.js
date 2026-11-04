/*
 * 입장 코드 만들기 (선생님용). 코드는 이 브라우저 안에서만 만들어지고 어디에도 보내거나 저장하지 않는다.
 * 코드 글자 목록과 길이는 입장 화면과 같은 값(placement-rules.js)을 쓴다.
 */
(() => {
  'use strict';
  const R = window.NatureRules;
  const WORLD_ID = 'nature-prototype';
  const $ = (id) => document.getElementById(id);
  let code = '';

  // crypto.getRandomValues로 만들고, 글자 수(26)로 나눌 때 한쪽으로 쏠리지 않게 256 미만의 배수 안에서만 고른다.
  function makeCode() {
    const alphabet = R.CODE_ALPHABET;
    const limit = 256 - (256 % alphabet.length);
    let out = '';
    while (out.length < R.CODE_LENGTH) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      for (const b of bytes) { if (b < limit && out.length < R.CODE_LENGTH) out += alphabet[b % alphabet.length]; }
    }
    return out;
  }
  function sqlFor(value) {
    return `update public.classrooms\n   set join_code_hash = extensions.crypt('${value}', extensions.gen_salt('bf')),\n       rotated_at = clock_timestamp()\n where world_id = '${WORLD_ID}';\n\n-- 확인용(true 가 나오면 성공):\nselect extensions.crypt('${value}', join_code_hash) = join_code_hash as code_ok\n  from public.classrooms where world_id = '${WORLD_ID}';`;
  }
  function stamp() {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
  }
  function fileText(value) {
    const t = stamp();
    return `모두 함께 만드는 우리의 공간 - 입장 코드\n만든 때: ${t.day} ${t.time}\n\n입장 코드: ${value}\n\n※ 이 파일은 공개된 곳(GitHub, 공유 폴더)에 올리지 마세요.\n※ Supabase에 아래 SQL을 실행해야 이 코드로 바뀝니다. 실행하기 전까지는 이전 코드가 계속 쓰여요.\n\n----- Supabase SQL Editor에 붙여넣을 내용 -----\n${sqlFor(value)}\n`;
  }
  function say(text) { $('cm-status').textContent = text; }
  function render() {
    code = makeCode();
    $('cm-code').textContent = code;
    $('cm-sql').textContent = sqlFor(code);
    say('새 코드를 만들었어요. 아직 서버에는 적용되지 않았어요(SQL을 실행해야 해요).');
  }
  function download() {
    const blob = new Blob([fileText(code)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `join-code-${stamp().day}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    say('코드 파일을 내려받았어요. 다운로드 폴더를 확인해 보세요.');
  }
  async function copySql() {
    try { await navigator.clipboard.writeText(sqlFor(code)); say('SQL을 복사했어요. Supabase SQL Editor에 붙여넣으세요.'); }
    catch (error) { const range = document.createRange(); range.selectNodeContents($('cm-sql')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); say('자동 복사가 안 돼서 SQL을 선택해 뒀어요. Ctrl+C(맥은 ⌘+C)로 복사하세요.'); $('cm-sql').closest('details').open = true; }
  }
  window.addEventListener('load', () => {
    $('cm-new').addEventListener('click', render);
    $('cm-download').addEventListener('click', download);
    $('cm-copy-sql').addEventListener('click', copySql);
    render();
  });
})();
