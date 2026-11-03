-- 0003: 실시간(Broadcast/Presence) 채널을 "학급 활성 멤버"만 쓰도록 좁힌다.
--
-- 왜 필요한가
--   0001의 정책은 로그인한 사용자(익명 로그인 포함)라면 누구나 'world:nature-prototype' 채널에
--   들어오게 했다. 익명 로그인은 입장 코드 없이도 되므로, 주소만 아는 사람이 채널을 엿보거나
--   메시지를 보낼 수 있었다. 이 파일은 입장 코드(join_class)를 통과해 class_members에 올라 있고
--   해지(revoked_at)되지 않은 사용자만 채널을 읽고 쓰게 한다.
--
-- 바뀌는 것 / 바뀌지 않는 것
--   바뀜: realtime.messages의 정책 2개(받기, 보내기)
--   안 바뀜: 0002의 테이블·함수·정책, world_state 정책, 자연물 변경 알림(Postgres Changes).
--            자연물 변경 알림은 nature_objects의 RLS가 이미 멤버만 읽게 막고 있다.
--
-- 채널 이름 규칙: 'world:' + 학급의 world_id  (예: world:nature-prototype)
-- 클라이언트 순서: 익명 로그인 -> join_class(코드) 성공 -> 채널 구독
--   (순서가 바뀌어 구독이 먼저면 거부된다. 입장 후 다시 구독하면 된다.)
--
-- 여러 번 실행해도 안전하다(drop ... if exists 후 다시 만든다).

-- 이전(0001) 정책 제거
drop policy if exists "authenticated users can receive prototype realtime" on realtime.messages;
drop policy if exists "authenticated users can send prototype realtime" on realtime.messages;

-- 이 파일의 정책(재실행 대비)
drop policy if exists "class members can receive world realtime" on realtime.messages;
drop policy if exists "class members can send world realtime" on realtime.messages;

-- 받기: 채널 이름이 'world:<내가 활성 멤버인 학급의 world_id>'일 때만
create policy "class members can receive world realtime"
on realtime.messages
for select
to authenticated
using (
  extension in ('broadcast', 'presence')
  and exists (
    select 1
      from public.class_members cm
     where cm.user_id = (select auth.uid())
       and cm.revoked_at is null
       and realtime.topic() = 'world:' || cm.world_id
  )
);

-- 보내기: 같은 조건
create policy "class members can send world realtime"
on realtime.messages
for insert
to authenticated
with check (
  extension in ('broadcast', 'presence')
  and exists (
    select 1
      from public.class_members cm
     where cm.user_id = (select auth.uid())
       and cm.revoked_at is null
       and realtime.topic() = 'world:' || cm.world_id
  )
);
