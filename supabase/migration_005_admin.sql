-- FoodVibe migration 005 — Manager dashboard + admins (FOODVIBE.md §15)
-- Run AFTER schema.sql + migration_002 + migration_003 + migration_004
-- + migration_006 (this file redefines nearby_sellers ON TOP of 006's
-- version, keeping its exact signature and behaviour, plus suspension
-- filtering). Idempotent: safe to run more than once.
--
-- What lands here:
--  * admins — the allowlist of dashboard admins, keyed by email. Only
--    an existing admin can add/remove emails (via the RPCs below).
--    Frame's account (itsvfxcook@gmail.com) is the seeded ROOT admin;
--    the root can never be removed, and the last admin can never be
--    removed, so the dashboard can never lock everyone out.
--  * is_admin() — true when the caller's auth email is in admins.
--  * profiles.is_admin — a mirror flag (§15: "their profile becomes
--    admin"), kept in sync by triggers whenever the admins table or a
--    profile changes.
--  * sellers.suspended / suspended_at — a suspended seller disappears
--    from Explore (nearby_sellers below) until reinstated.
--  * reports.status — 'open' | 'dismissed' | 'actioned' queue state
--    for the dashboard's reports queue (the app only ever inserts;
--    the column default keeps in-app reports 'open').
--  * admin_* RPCs — every dashboard read/action goes through a
--    security-definer RPC guarded by is_admin(). The browser only
--    ever holds the anon key + the admin's own session; there is NO
--    service-role key in the dashboard, and RLS stays on everywhere.

-- ---------- admins allowlist ----------
create table if not exists public.admins (
  email text primary key,
  added_by text,
  created_at timestamptz not null default now()
);

-- The seeded root admin (Frame). Can never be removed (see
-- admin_remove_admin).
insert into public.admins (email, added_by)
values ('itsvfxcook@gmail.com', 'seed:migration_005')
on conflict (email) do nothing;

-- ---------- is_admin(): the one guard every RPC uses ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------- profiles.is_admin mirror (§15) ----------
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Backfill for profiles that already exist.
update public.profiles p
set is_admin = true
from auth.users u
where u.id = p.id
  and exists (
    select 1 from public.admins a where lower(a.email) = lower(u.email)
  );

-- Keep the mirror in sync when the allowlist changes.
create or replace function public.sync_profile_admin_flag()
returns trigger language plpgsql security definer set search_path = public as $$
declare target_email text;
begin
  target_email := lower(coalesce(new.email, old.email));
  update public.profiles p
  set is_admin = exists (
    select 1 from public.admins a where lower(a.email) = target_email
  )
  from auth.users u
  where u.id = p.id and lower(u.email) = target_email;
  return coalesce(new, old);
end $$;

drop trigger if exists admins_sync_profile_flag on public.admins;
create trigger admins_sync_profile_flag
  after insert or update or delete on public.admins
  for each row execute function public.sync_profile_admin_flag();

-- And when a profile is created for an already-approved email (a person
-- approved before they ever signed in), flag it from birth.
create or replace function public.profile_admin_flag_on_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select exists (
    select 1 from public.admins a
    join auth.users u on lower(u.email) = lower(a.email)
    where u.id = new.id
  ) into new.is_admin;
  return new;
end $$;

drop trigger if exists profiles_admin_flag_insert on public.profiles;
create trigger profiles_admin_flag_insert
  before insert on public.profiles
  for each row execute function public.profile_admin_flag_on_insert();

-- ---------- seller suspension ----------
alter table public.sellers add column if not exists suspended boolean not null default false;
alter table public.sellers add column if not exists suspended_at timestamptz;

-- ---------- report queue state ----------
alter table public.reports add column if not exists status text not null default 'open';
do $$ begin
  alter table public.reports add constraint reports_status_check
    check (status in ('open','dismissed','actioned'));
exception when duplicate_object then null; end $$;
create index if not exists reports_status_idx on public.reports (status, created_at desc);

-- ---------- nearby_sellers v4 = 006's v3 + suspension filter ----------
-- Identical signature and return shape to migration_006, identical
-- open_now / listing rules — the ONLY change is the extra predicate
-- `and not s.suspended` in the WHERE clause, so a suspended seller
-- vanishes from Explore for every buyer until reinstated.
create or replace function public.nearby_sellers(p_lat double precision, p_lng double precision, p_radius_m int default 3000)
returns table (
  seller_id uuid, display_name text, speciality text, photo_url text,
  instagram text, whatsapp text, upi_id text, upi_qr_url text,
  seller_type text, opening_time time, closing_time time, open_now boolean,
  category text, route_pincodes text[], is_live boolean,
  latitude double precision, longitude double precision,
  distance_m double precision, rating_avg numeric, rating_count bigint, updated_at timestamptz
) language sql stable security definer set search_path = public as $$
  select s.id, p.display_name, s.speciality, s.photo_url, s.instagram, s.whatsapp,
         s.upi_id, s.upi_qr_url, s.seller_type, s.opening_time, s.closing_time,
         case
           when s.seller_type = 'mobile' then true
           when s.seller_type = 'route' then
             l.is_live and l.updated_at > now() - interval '30 minutes'
           when s.opening_time is null or s.closing_time is null then l.is_live
           when s.opening_time <= s.closing_time
             then localtime between s.opening_time and s.closing_time
           else localtime >= s.opening_time or localtime <= s.closing_time  -- overnight shops
         end as open_now,
         s.category, s.route_pincodes,
         (l.is_live and l.updated_at > now() - interval '30 minutes') as is_live,
         st_y(l.pos::geometry) as latitude,
         st_x(l.pos::geometry) as longitude,
         st_distance(l.pos, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) as distance_m,
         coalesce(r.avg_stars, 0), coalesce(r.cnt, 0), l.updated_at
  from public.seller_locations l
  join public.sellers s on s.id = l.seller_id
  join public.profiles p on p.id = s.id
  left join (
    select seller_id, round(avg(stars)::numeric, 2) as avg_stars, count(*) as cnt
    from public.purchases group by seller_id
  ) r on r.seller_id = s.id
  where st_dwithin(l.pos, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, p_radius_m)
    and not s.suspended
    and (
      -- mobile: only while travelling live (fresh ping).
      (s.seller_type = 'mobile' and l.is_live = true
         and l.updated_at > now() - interval '30 minutes')
      -- permanent: always listed; open_now carries the truth.
      or s.seller_type = 'permanent'
      -- route: always listed once a start point exists; open_now says
      -- whether the journey is on. The app filters by the buyer's
      -- pincode against route_pincodes.
      or s.seller_type = 'route'
    )
  order by open_now desc, distance_m asc;
$$;

-- ---------- shared guard for the RPCs below ----------
-- Every admin RPC starts with: if not is_admin() then raise.
-- (Inlined per-function below because plpgsql has no macros.)

-- ---------- admin_overview ----------
-- "Today" is Asia/Kolkata — FoodVibe's only market. "Sellers live now"
-- = a fresh live ping (is_live and ping < 30 min old), the same rule
-- nearby_sellers uses for mobile/route sellers.
create or replace function public.admin_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return jsonb_build_object(
    'total_users',      (select count(*) from public.profiles),
    'signups_today',    (select count(*) from public.profiles
                          where (created_at at time zone 'Asia/Kolkata')::date
                              = (now() at time zone 'Asia/Kolkata')::date),
    'signups_7d',       (select count(*) from public.profiles
                          where created_at >= now() - interval '7 days'),
    'sellers_live_now', (select count(*) from public.seller_locations
                          where is_live = true
                            and updated_at > now() - interval '30 minutes'),
    'total_sellers',    (select count(*) from public.sellers),
    'suspended_sellers',(select count(*) from public.sellers where suspended),
    'total_purchases',  (select count(*) from public.purchases),
    'avg_rating',       (select round(avg(stars)::numeric, 2) from public.purchases),
    'open_reports',     (select count(*) from public.reports where status = 'open')
  );
end $$;

-- ---------- admin_signups_by_day ----------
-- One row per day for the last p_days days (oldest first), zero-filled
-- so the dashboard chart never has gaps. Days are Asia/Kolkata dates.
create or replace function public.admin_signups_by_day(p_days int default 30)
returns table (day date, signups bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select days.d::date as day,
           count(p.id) as signups
    from generate_series(
           (now() at time zone 'Asia/Kolkata')::date - (greatest(p_days, 1) - 1),
           (now() at time zone 'Asia/Kolkata')::date,
           interval '1 day'
         ) as days(d)
    left join public.profiles p
      on (p.created_at at time zone 'Asia/Kolkata')::date = days.d::date
    group by days.d
    order by days.d;
end $$;

-- ---------- admin_users ----------
create or replace function public.admin_users()
returns table (
  id uuid, email text, display_name text, role text, language text,
  phone text, created_at timestamptz, is_seller boolean, is_admin boolean,
  push_alerts boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select p.id, u.email::text, p.display_name, p.role::text, p.language,
           p.phone, p.created_at,
           exists (select 1 from public.sellers s where s.id = p.id) as is_seller,
           exists (select 1 from public.admins a
                    where lower(a.email) = lower(u.email)) as is_admin,
           p.push_alerts
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.created_at desc;
end $$;

-- ---------- admin_sellers ----------
-- is_live mirrors nearby_sellers: a fresh is_live ping (< 30 min).
create or replace function public.admin_sellers()
returns table (
  id uuid, display_name text, email text, speciality text,
  seller_type text, category text, photo_url text,
  suspended boolean, suspended_at timestamptz,
  is_live boolean, latitude double precision, longitude double precision,
  location_updated_at timestamptz,
  rating_avg numeric, rating_count bigint, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select s.id, p.display_name, u.email::text, s.speciality,
           s.seller_type, s.category, s.photo_url,
           s.suspended, s.suspended_at,
           coalesce(l.is_live and l.updated_at > now() - interval '30 minutes', false) as is_live,
           case when l.pos is not null then st_y(l.pos::geometry) end as latitude,
           case when l.pos is not null then st_x(l.pos::geometry) end as longitude,
           l.updated_at as location_updated_at,
           coalesce(r.avg_stars, 0) as rating_avg,
           coalesce(r.cnt, 0) as rating_count,
           s.created_at
    from public.sellers s
    join public.profiles p on p.id = s.id
    join auth.users u on u.id = s.id
    left join public.seller_locations l on l.seller_id = s.id
    left join (
      select seller_id, round(avg(stars)::numeric, 2) as avg_stars, count(*) as cnt
      from public.purchases group by seller_id
    ) r on r.seller_id = s.id
    order by s.suspended asc,
             coalesce(l.is_live and l.updated_at > now() - interval '30 minutes', false) desc,
             s.created_at desc;
end $$;

-- ---------- admin_area_density ----------
-- PRIVACY (§13/§15): buyers are NEVER exposed individually. This RPC
-- only returns grid cells (~0.025° ≈ 2.5 km) built from the buyers'
-- already-rounded notify_lat/notify_lng alert areas, with a head-count
-- per cell. The dashboard draws these as soft heat circles — never
-- pins. Cells with a single user are merged into the count of their
-- cell like any other; a cell IS an area, not a person.
create or replace function public.admin_area_density()
returns table (
  cell_lat double precision, cell_lng double precision, user_count bigint
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select floor(notify_lat / 0.025) * 0.025 + 0.0125 as cell_lat,
           floor(notify_lng / 0.025) * 0.025 + 0.0125 as cell_lng,
           count(*) as user_count
    from public.profiles
    where notify_lat is not null and notify_lng is not null
    group by 1, 2
    order by user_count desc;
end $$;

-- ---------- admin_reports ----------
-- Open reports first, then everything else, newest first. Includes
-- handled reports so the queue doubles as the moderation history.
create or replace function public.admin_reports()
returns table (
  id uuid, status text, reason text, note text, created_at timestamptz,
  seller_id uuid, seller_name text, seller_suspended boolean,
  reporter_id uuid, reporter_name text, reporter_email text
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select r.id, r.status, r.reason, r.note, r.created_at,
           r.seller_id,
           sp.display_name as seller_name,
           coalesce(s.suspended, false) as seller_suspended,
           r.reporter_id,
           rp.display_name as reporter_name,
           ru.email::text as reporter_email
    from public.reports r
    left join public.sellers s on s.id = r.seller_id
    left join public.profiles sp on sp.id = r.seller_id
    left join public.profiles rp on rp.id = r.reporter_id
    left join auth.users ru on ru.id = r.reporter_id
    order by (r.status = 'open') desc, r.created_at desc
    limit 500;
end $$;

-- ---------- admin_set_report ----------
create or replace function public.admin_set_report(p_report_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_status not in ('open','dismissed','actioned') then
    return jsonb_build_object('ok', false, 'error', 'invalid status');
  end if;
  update public.reports set status = p_status where id = p_report_id;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'error', 'report not found');
  end if;
  return jsonb_build_object('ok', true, 'id', p_report_id, 'status', p_status);
end $$;

-- ---------- admin_suspend_seller ----------
create or replace function public.admin_suspend_seller(p_seller_id uuid, p_suspended boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.sellers
  set suspended = p_suspended,
      suspended_at = case when p_suspended then now() else null end
  where id = p_seller_id;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'error', 'seller not found');
  end if;
  return jsonb_build_object('ok', true, 'id', p_seller_id, 'suspended', p_suspended);
end $$;

-- ---------- admin list / add / remove ----------
create or replace function public.admin_list_admins()
returns table (email text, added_by text, created_at timestamptz, is_root boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select a.email, a.added_by, a.created_at,
           (lower(a.email) = 'itsvfxcook@gmail.com') as is_root
    from public.admins a
    order by a.created_at asc;
end $$;

create or replace function public.admin_add_admin(p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare clean text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if clean = '' or clean !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'that does not look like an email address');
  end if;
  insert into public.admins (email, added_by)
  values (clean, lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (email) do nothing;
  return jsonb_build_object('ok', true, 'email', clean);
end $$;

create or replace function public.admin_remove_admin(p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare clean text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  -- The seeded root admin can never be removed.
  if clean = 'itsvfxcook@gmail.com' then
    return jsonb_build_object('ok', false,
      'error', 'the root admin (itsvfxcook@gmail.com) cannot be removed');
  end if;
  -- Nor can the last remaining admin — the dashboard must never lock
  -- everyone out.
  if (select count(*) from public.admins) <= 1 then
    return jsonb_build_object('ok', false,
      'error', 'cannot remove the last remaining admin');
  end if;
  if not exists (select 1 from public.admins a where lower(a.email) = clean) then
    return jsonb_build_object('ok', false, 'error', 'that email is not an admin');
  end if;
  delete from public.admins a where lower(a.email) = clean;
  return jsonb_build_object('ok', true, 'email', clean);
end $$;

-- ---------- RLS: admins table ----------
-- RLS on; admins may read the allowlist directly (the RPCs cover
-- everything else). There are deliberately NO insert/update/delete
-- policies: allowlist changes go only through the guarded RPCs above.
alter table public.admins enable row level security;

drop policy if exists admins_admin_read on public.admins;
create policy admins_admin_read on public.admins
  for select using (public.is_admin());

-- ---------- grants ----------
-- The dashboard calls these as the signed-in admin (authenticated
-- role). anon gets nothing.
revoke execute on function public.is_admin() from public;
revoke execute on function public.admin_overview() from public;
revoke execute on function public.admin_signups_by_day(int) from public;
revoke execute on function public.admin_users() from public;
revoke execute on function public.admin_sellers() from public;
revoke execute on function public.admin_area_density() from public;
revoke execute on function public.admin_reports() from public;
revoke execute on function public.admin_set_report(uuid, text) from public;
revoke execute on function public.admin_suspend_seller(uuid, boolean) from public;
revoke execute on function public.admin_list_admins() from public;
revoke execute on function public.admin_add_admin(text) from public;
revoke execute on function public.admin_remove_admin(text) from public;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_signups_by_day(int) to authenticated;
grant execute on function public.admin_users() to authenticated;
grant execute on function public.admin_sellers() to authenticated;
grant execute on function public.admin_area_density() to authenticated;
grant execute on function public.admin_reports() to authenticated;
grant execute on function public.admin_set_report(uuid, text) to authenticated;
grant execute on function public.admin_suspend_seller(uuid, boolean) to authenticated;
grant execute on function public.admin_list_admins() to authenticated;
grant execute on function public.admin_add_admin(text) to authenticated;
grant execute on function public.admin_remove_admin(text) to authenticated;
