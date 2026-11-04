-- 0004: 자연물 종류 12가지로 늘리기 + 따로 만든 입장 코드(시연용 등)
--
-- 이 파일이 하는 일 (Supabase 대시보드 > SQL Editor에서 한 번 실행합니다)
--   1) nature_objects.kind 에 새 종류를 허용한다.
--      돌(rock)·꽃(wildflower)·작은 나무(shrub)·다람쥐(squirrel)·토끼(rabbit)·나비(butterfly)·
--      작은 연못(pond)·갈대(reed)·덩굴(vine)·벌집(beehive)·물고기(fish)·수련(waterlily)
--      (예전에 놓은 쓰러진 나뭇가지 fallen_branch 도 남아 있을 수 있어 계속 허용한다.)
--   2) 종류마다 겹침 반경을 한 곳(nature_kind_radius)에서 관리한다. 값은 화면 쪽 규칙(placement-rules.js)과 같아야 한다.
--   3) 연못(pond) 안에 놓는 물고기·수련은 연못과 겹쳐도 되게 한다(nature_kinds_may_overlap).
--   4) 학급 공용 코드 말고 '따로 만든 입장 코드'를 여러 개 둘 수 있게 한다(class_join_codes).
--      join_class 는 공용 코드를 먼저 보고, 맞지 않으면 따로 만든 코드를 본다. 코드는 해시로만 저장한다.
--
-- 서버가 확인하지 않는 규칙(화면에서만 막는다): 물고기·수련은 물 위에만, 벌집은 나무에만, 길·물·장식 위 금지.
--   서버는 이전과 같이 월드 경계, 종류, 개수(내 12개·월드 300개), 쓰기 속도, 겹침만 판단한다.
-- 여러 번 실행해도 안전하다.

-- 1) 종류 허용 목록
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.nature_objects'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%kind%'
  loop
    execute format('alter table public.nature_objects drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.nature_objects
  add constraint nature_objects_kind_check check (kind in (
    'rock', 'wildflower', 'shrub', 'squirrel', 'rabbit', 'butterfly',
    'pond', 'reed', 'vine', 'beehive', 'fish', 'waterlily', 'fallen_branch'
  ));

comment on column public.nature_objects.kind is
  '허용 종류: rock, wildflower, shrub, squirrel, rabbit, butterfly, pond, reed, vine, beehive, fish, waterlily (+ 예전 fallen_branch).';

-- 2) 종류별 겹침 반경 (placement-rules.js 의 KINDS.radius 와 같은 값)
create or replace function public.nature_kind_radius(p_kind text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'rock' then 34
    when 'wildflower' then 26
    when 'shrub' then 70
    when 'squirrel' then 24
    when 'rabbit' then 26
    when 'butterfly' then 18
    when 'pond' then 76
    when 'reed' then 30
    when 'vine' then 34
    when 'beehive' then 22
    when 'fish' then 16
    when 'waterlily' then 24
    when 'fallen_branch' then 42
  end::numeric;
$$;

-- 3) 연못과 그 안의 물고기·수련은 겹쳐도 된다
create or replace function public.nature_kinds_may_overlap(p_a text, p_b text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_a = 'pond' and p_b in ('fish', 'waterlily'))
      or (p_b = 'pond' and p_a in ('fish', 'waterlily'));
$$;

-- 4) 따로 만든 입장 코드
create table if not exists public.class_join_codes (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classrooms(id) on delete cascade,
  label text not null,
  code_hash text not null check (char_length(code_hash) > 0),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (class_id, label)
);
comment on table public.class_join_codes is
  '학급 공용 코드 외에 따로 만든 입장 코드(시연용 등)의 해시. 평문은 저장하지 않는다. 쓰지 않을 코드는 revoked_at 을 채운다.';
alter table public.class_join_codes enable row level security;
revoke all on public.class_join_codes from anon, authenticated;

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

  -- 학급 공용 코드가 아니면, 따로 만든 입장 코드(시연용 등) 중 해지되지 않은 것과 맞는지 본다.
  if v_class_id is null then
    select c.id, c.world_id
      into v_class_id, v_world_id
      from public.class_join_codes jc
      join public.classrooms c on c.id = jc.class_id
     where jc.revoked_at is null
       and extensions.crypt(v_code, jc.code_hash) = jc.code_hash
     limit 1;
  end if;

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

  if public.nature_kind_radius(p_kind) is null then
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

  v_radius := public.nature_kind_radius(p_kind) * p_scale;
  -- 겹침: 중심 거리가 반경 합보다 작으면 거절. 연못 위의 물고기·수련은 연못과 겹쳐도 된다.
  if exists (
    select 1 from public.nature_objects n
     where n.world_id = p_world_id
       and n.deleted_at is null
       and not public.nature_kinds_may_overlap(p_kind, n.kind)
       and power(n.x - p_x, 2) + power(n.y - p_y, 2) < power(v_radius + public.nature_kind_radius(n.kind) * n.scale, 2)
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
  v_radius := public.nature_kind_radius(v_object.kind) * v_object.scale;
  if exists (
    select 1 from public.nature_objects n
     where n.world_id = v_object.world_id
       and n.deleted_at is null
       and n.id <> p_object_id
       and not public.nature_kinds_may_overlap(v_object.kind, n.kind)
       and power(n.x - p_x, 2) + power(n.y - p_y, 2) < power(v_radius + public.nature_kind_radius(n.kind) * n.scale, 2)
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

revoke all on function public.nature_kind_radius(text), public.nature_kinds_may_overlap(text, text) from public, anon, authenticated;
-- create or replace 는 기존 실행 권한을 유지하지만, 안전하게 다시 지정한다.
revoke execute on function public.join_class(text),
  public.create_nature_object(text, text, numeric, numeric, numeric, numeric),
  public.move_nature_object(uuid, numeric, numeric, integer, numeric) from public, anon;
grant execute on function public.join_class(text),
  public.create_nature_object(text, text, numeric, numeric, numeric, numeric),
  public.move_nature_object(uuid, numeric, numeric, integer, numeric) to authenticated;
