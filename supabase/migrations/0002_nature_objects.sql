-- 공동 자연물 설치 1단계
-- 전제: public.world_state(id text)가 0001 마이그레이션에서 이미 생성되어 있다.
-- 이 파일은 world_state 및 realtime.messages의 기존 정책을 변경하지 않는다.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.classrooms (
  id uuid primary key default gen_random_uuid(),
  world_id text not null unique references public.world_state(id) on delete cascade,
  join_code_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  rotated_at timestamptz not null default clock_timestamp(),
  constraint classrooms_join_code_hash_not_empty check (char_length(join_code_hash) > 0)
);

comment on table public.classrooms is
  '월드별 학급 입장 코드의 해시를 보관한다. 평문 입장 코드는 저장하지 않는다.';

create table if not exists public.class_members (
  class_id uuid not null references public.classrooms(id) on delete cascade,
  world_id text not null references public.world_state(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'student' check (role in ('student', 'teacher')),
  joined_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  primary key (class_id, user_id)
);

comment on table public.class_members is
  '익명 인증 사용자를 포함한 학급 멤버십이다. world_id는 RLS 멤버십 판정에 사용하며, revoked_at은 교사의 SQL로만 복구한다.';

create index if not exists class_members_active_user_idx
  on public.class_members (user_id, class_id) where revoked_at is null;

create table if not exists public.class_join_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_count integer not null default 0 check (failed_count >= 0),
  window_started_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table public.class_join_attempts is
  '익명 사용자별 입장 코드 오입력 횟수. IP 단위 제한은 PostgreSQL RPC만으로 구현하지 못한다.';

create table if not exists public.nature_objects (
  id uuid primary key default gen_random_uuid(),
  world_id text not null references public.world_state(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('rock', 'wildflower', 'shrub', 'fallen_branch')),
  x numeric(8,2) not null,
  y numeric(8,2) not null,
  rotation numeric(6,2) not null default 0,
  scale numeric(4,2) not null default 1.00 check (scale between 0.50 and 2.00),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint nature_objects_world_bounds check (x between 0 and 2399 and y between 0 and 1499),
  constraint nature_objects_rotation_bounds check (rotation between -360 and 360),
  constraint nature_objects_deletion_audit check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  )
);

comment on table public.nature_objects is
  '공동 월드 자연물. 삭제는 deleted_at/deleted_by를 채우는 소프트 삭제만 허용한다.';
comment on column public.nature_objects.kind is
  '1차 허용 종류: rock, wildflower, shrub, fallen_branch. SVG 에셋은 별도 배포물에서 관리한다.';
comment on column public.nature_objects.x is
  '월드 좌표. 물/길 판정 규칙은 이후 지형 데이터 테이블 또는 서버 함수로 분리한다.';

create index if not exists nature_objects_active_world_idx
  on public.nature_objects (world_id, created_at) where deleted_at is null;
create index if not exists nature_objects_active_owner_idx
  on public.nature_objects (owner_id, world_id) where deleted_at is null;

create table if not exists public.nature_object_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  world_id text not null references public.world_state(id) on delete cascade,
  last_write_at timestamptz not null default clock_timestamp(),
  primary key (user_id, world_id)
);

comment on table public.nature_object_rate_limits is
  '사용자·월드별 마지막 자연물 쓰기 시각. RPC 내부에서만 사용한다.';

alter table public.classrooms enable row level security;
alter table public.class_members enable row level security;
alter table public.class_join_attempts enable row level security;
alter table public.nature_objects enable row level security;
alter table public.nature_object_rate_limits enable row level security;

-- 입장 코드 해시, 실패 횟수, 속도 제한 내역은 브라우저에서 읽을 수 없다.
create policy "members can read their own membership"
  on public.class_members for select to authenticated
  using (user_id = (select auth.uid()));

-- deleted_at 조건을 의도적으로 넣지 않는다. 클라이언트는 최초 목록에서 deleted_at is null을
-- 적용하고, Realtime UPDATE에서 deleted_at이 채워진 행을 화면에서 제거한다.
create policy "active members can read world nature objects"
  on public.nature_objects for select to authenticated
  using (
    exists (
      select 1 from public.class_members cm
       where cm.user_id = (select auth.uid())
         and cm.revoked_at is null
         and cm.world_id = nature_objects.world_id
    )
  );

-- 브라우저의 직접 INSERT/UPDATE/DELETE를 허용하지 않는다. 모든 변경은 아래 SECURITY DEFINER
-- RPC에서 소유권, 상한, 속도, 겹침을 확인한 뒤 수행한다.
revoke all on public.classrooms, public.class_members, public.class_join_attempts,
  public.nature_objects, public.nature_object_rate_limits from anon, authenticated;
grant select on public.class_members, public.nature_objects to authenticated;

create or replace function public.join_class(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := upper(trim(p_code));
  v_class_id uuid;
  v_world_id text;
  v_revoked_at timestamptz;
  v_failed_count integer;
  v_window_started_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
    raise exception 'invalid join-code format' using errcode = '22023';
  end if;

  insert into public.class_join_attempts as a (user_id, failed_count, window_started_at, updated_at)
  values (v_user_id, 0, clock_timestamp(), clock_timestamp())
  on conflict (user_id) do update set updated_at = excluded.updated_at;

  select failed_count, window_started_at
    into v_failed_count, v_window_started_at
    from public.class_join_attempts
   where user_id = v_user_id
   for update;

  if v_window_started_at < clock_timestamp() - interval '10 minutes' then
    update public.class_join_attempts
       set failed_count = 0,
           window_started_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where user_id = v_user_id;
    v_failed_count := 0;
  end if;

  if v_failed_count >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'world_id', null);
  end if;

  select c.id, c.world_id
    into v_class_id, v_world_id
    from public.classrooms c
   where extensions.crypt(v_code, c.join_code_hash) = c.join_code_hash;

  if v_class_id is null then
    update public.class_join_attempts
       set failed_count = failed_count + 1,
           updated_at = clock_timestamp()
     where user_id = v_user_id;
    return jsonb_build_object('ok', false, 'reason', 'invalid_code', 'world_id', null);
  end if;

  select cm.revoked_at
    into v_revoked_at
    from public.class_members cm
   where cm.class_id = v_class_id and cm.user_id = v_user_id;

  if found and v_revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'membership_revoked', 'world_id', v_world_id);
  end if;

  insert into public.class_members (class_id, world_id, user_id, role)
  values (v_class_id, v_world_id, v_user_id, 'student')
  on conflict (class_id, user_id) do nothing;

  update public.class_join_attempts
     set failed_count = 0,
         window_started_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where user_id = v_user_id;

  return jsonb_build_object('ok', true, 'reason', 'joined', 'world_id', v_world_id);
end;
$$;

create or replace function public.rotate_class_join_code(p_class_id uuid, p_new_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := upper(trim(p_new_code));
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
    raise exception 'invalid join-code format' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.class_members cm
    where cm.class_id = p_class_id
      and cm.user_id = v_user_id
      and cm.role = 'teacher'
      and cm.revoked_at is null
  ) then
    raise exception 'teacher membership required' using errcode = '42501';
  end if;

  update public.classrooms
     set join_code_hash = extensions.crypt(v_code, extensions.gen_salt('bf')),
         rotated_at = clock_timestamp()
   where id = p_class_id;
  if not found then
    raise exception 'classroom not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true, 'reason', 'rotated');
end;
$$;

create or replace function public.assert_active_class_member(p_world_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.class_members cm
     where cm.user_id = auth.uid()
       and cm.revoked_at is null
       and cm.world_id = p_world_id
  ) then
    raise exception 'active class membership required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.enforce_nature_object_write_rate(p_world_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_write_at timestamptz;
begin
  insert into public.nature_object_rate_limits as r (user_id, world_id, last_write_at)
  values (auth.uid(), p_world_id, clock_timestamp())
  on conflict (user_id, world_id) do nothing
  returning last_write_at into v_last_write_at;

  -- 첫 쓰기는 방금 생성한 행을 성공으로 처리한다. 기존 행만 잠가서 간격을 판정한다.
  if found then
    return;
  end if;

  select last_write_at into v_last_write_at
    from public.nature_object_rate_limits
   where user_id = auth.uid() and world_id = p_world_id
   for update;

  if v_last_write_at > clock_timestamp() - interval '2 seconds' then
    raise exception 'nature object write rate exceeded' using errcode = '42901';
  end if;

  update public.nature_object_rate_limits
     set last_write_at = clock_timestamp()
   where user_id = auth.uid() and world_id = p_world_id;
end;
$$;

create or replace function public.create_nature_object(
  p_world_id text,
  p_kind text,
  p_x numeric,
  p_y numeric,
  p_rotation numeric default 0,
  p_scale numeric default 1
)
returns public.nature_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_object public.nature_objects;
  v_radius numeric;
begin
  perform public.assert_active_class_member(p_world_id);
  perform public.enforce_nature_object_write_rate(p_world_id);

  if p_kind not in ('rock', 'wildflower', 'shrub', 'fallen_branch') then
    raise exception 'unsupported nature object kind' using errcode = '22023';
  end if;
  if p_x not between 0 and 2399 or p_y not between 0 and 1499 then
    raise exception 'world bounds exceeded' using errcode = '22023';
  end if;
  if p_rotation not between -360 and 360 or p_scale not between 0.50 and 2.00 then
    raise exception 'invalid transform' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_world_id, 0));
  if (select count(*) from public.nature_objects n
      where n.world_id = p_world_id and n.deleted_at is null) >= 300 then
    raise exception 'world nature object limit reached' using errcode = '54000';
  end if;
  if (select count(*) from public.nature_objects n
      where n.world_id = p_world_id and n.owner_id = auth.uid() and n.deleted_at is null) >= 12 then
    raise exception 'owner nature object limit reached' using errcode = '54000';
  end if;

  v_radius := case p_kind
    when 'wildflower' then 26 * p_scale
    when 'shrub' then 70 * p_scale
    when 'rock' then 34 * p_scale
    when 'fallen_branch' then 42 * p_scale
  end;
  if exists (
    select 1 from public.nature_objects n
     where n.world_id = p_world_id
       and n.deleted_at is null
       and power(n.x - p_x, 2) + power(n.y - p_y, 2) < power(v_radius +
          (case n.kind when 'wildflower' then 26 when 'shrub' then 70 when 'rock' then 34 else 42 end) * n.scale, 2)
  ) then
    raise exception 'nature object overlaps another object' using errcode = '23P01';
  end if;

  insert into public.nature_objects (world_id, owner_id, kind, x, y, rotation, scale)
  values (p_world_id, auth.uid(), p_kind, p_x, p_y, p_rotation, p_scale)
  returning * into v_object;
  return v_object;
end;
$$;

create or replace function public.move_nature_object(
  p_object_id uuid,
  p_x numeric,
  p_y numeric,
  p_expected_version integer,
  p_rotation numeric default 0
)
returns public.nature_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_object public.nature_objects;
  v_radius numeric;
begin
  select * into v_object from public.nature_objects where id = p_object_id for update;
  if not found or v_object.owner_id <> auth.uid() or v_object.deleted_at is not null then
    raise exception 'nature object not found' using errcode = 'P0002';
  end if;
  perform public.assert_active_class_member(v_object.world_id);
  if v_object.version <> p_expected_version then
    raise exception 'stale nature object version' using errcode = 'STALE';
  end if;
  perform public.enforce_nature_object_write_rate(v_object.world_id);
  if p_x not between 0 and 2399 or p_y not between 0 and 1499 or p_rotation not between -360 and 360 then
    raise exception 'invalid transform' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_object.world_id, 0));
  v_radius := (case v_object.kind when 'wildflower' then 26 when 'shrub' then 70 when 'rock' then 34 else 42 end) * v_object.scale;
  if exists (
    select 1 from public.nature_objects n
     where n.world_id = v_object.world_id
       and n.deleted_at is null
       and n.id <> p_object_id
       and power(n.x - p_x, 2) + power(n.y - p_y, 2) < power(v_radius +
          (case n.kind when 'wildflower' then 26 when 'shrub' then 70 when 'rock' then 34 else 42 end) * n.scale, 2)
  ) then
    raise exception 'nature object overlaps another object' using errcode = '23P01';
  end if;

  update public.nature_objects
      set x = p_x, y = p_y, rotation = p_rotation, updated_at = clock_timestamp(), version = version + 1
   where id = p_object_id
  returning * into v_object;
  return v_object;
end;
$$;

create or replace function public.delete_nature_object(p_object_id uuid, p_expected_version integer)
returns public.nature_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_object public.nature_objects;
begin
  select * into v_object from public.nature_objects where id = p_object_id for update;
  if not found or v_object.owner_id <> auth.uid() or v_object.deleted_at is not null then
    raise exception 'nature object not found' using errcode = 'P0002';
  end if;
  perform public.assert_active_class_member(v_object.world_id);
  if v_object.version <> p_expected_version then
    raise exception 'stale nature object version' using errcode = 'STALE';
  end if;
  perform public.enforce_nature_object_write_rate(v_object.world_id);
  update public.nature_objects
      set deleted_at = clock_timestamp(), deleted_by = auth.uid(), updated_at = clock_timestamp(), version = version + 1
   where id = p_object_id
  returning * into v_object;
  return v_object;
end;
$$;

create or replace function public.teacher_clear_nature_objects(p_world_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.class_members cm join public.classrooms c on c.id = cm.class_id
     where cm.user_id = auth.uid() and cm.role = 'teacher' and cm.revoked_at is null and c.world_id = p_world_id
  ) then
    raise exception 'teacher membership required' using errcode = '42501';
  end if;
  update public.nature_objects
      set deleted_at = clock_timestamp(), deleted_by = auth.uid(), updated_at = clock_timestamp(), version = version + 1
   where world_id = p_world_id and deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.assert_active_class_member(text), public.enforce_nature_object_write_rate(text)
  from public, anon, authenticated;
revoke execute on function public.join_class(text), public.rotate_class_join_code(uuid, text),
  public.create_nature_object(text, text, numeric, numeric, numeric, numeric),
  public.move_nature_object(uuid, numeric, numeric, integer, numeric),
  public.delete_nature_object(uuid, integer), public.teacher_clear_nature_objects(text) from public, anon;
grant execute on function public.join_class(text), public.rotate_class_join_code(uuid, text),
  public.create_nature_object(text, text, numeric, numeric, numeric, numeric),
  public.move_nature_object(uuid, numeric, numeric, integer, numeric),
  public.delete_nature_object(uuid, integer), public.teacher_clear_nature_objects(text) to authenticated;

-- Postgres Changes용 테이블 등록. realtime.messages 정책은 생성·변경하지 않는다.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.nature_objects';
  end if;
exception when duplicate_object then
  null;
end;
$$;
