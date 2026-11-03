-- 공동 자연 탐험 프로토타입의 최소 Supabase 설정입니다.
-- Dashboard SQL Editor에서 프로젝트 소유자 권한으로 한 번 실행합니다.
-- 브라우저에는 publishable(또는 legacy anon) 키만 사용하고, service_role 키는 절대 넣지 않습니다.

create table if not exists public.world_state (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.world_state enable row level security;

grant select on public.world_state to authenticated;

create policy "authenticated users can read the prototype world"
on public.world_state
for select
to authenticated
using (id = 'nature-prototype');

-- 현재 클라이언트는 world_state를 읽기만 합니다. 브라우저 INSERT/UPDATE/DELETE 정책은 만들지 않습니다.
-- 월드 편집 기능을 추가할 때에는 서버/RPC에서 auth.uid()와 오브젝트 owner_id를 함께 검증합니다.

insert into public.world_state (id, payload, revision)
values ('nature-prototype', '{}'::jsonb, 0)
on conflict (id) do nothing;

-- Broadcast/Presence 전용 비공개 채널 권한입니다.
-- realtime.messages는 Supabase가 관리하며 RLS가 이미 켜져 있으므로 ALTER TABLE을 실행하지 않습니다.
create policy "authenticated users can receive prototype realtime"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() = 'world:nature-prototype'
  and extension in ('broadcast', 'presence')
);

create policy "authenticated users can send prototype realtime"
on realtime.messages
for insert
to authenticated
with check (
  realtime.topic() = 'world:nature-prototype'
  and extension in ('broadcast', 'presence')
);

-- 현재 앱은 Postgres Changes를 구독하지 않습니다. 이후 world_state 변경 구독을 구현할 때만 아래 줄의 주석을 해제합니다.
-- alter publication supabase_realtime add table public.world_state;
