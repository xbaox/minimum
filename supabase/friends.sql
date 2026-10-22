-- «Минимум» · Друзья — схема Supabase. Запускать целиком в SQL Editor; повторный запуск безопасен.
--
-- Как устроено:
--   * Таблицы лежат в закрытой схеме minimum — Data API её не видит, у anon/authenticated нет даже USAGE.
--   * Снаружи доступны только функции public.minimum_*. Каждая первым делом проверяет секрет устройства
--     (256 бит, в базе — только sha256) и работает от владельца (security definer, пустой search_path).
--   * Почта, пароли и сессии не нужны: личность — это секрет, который живёт на телефоне.
--   * Друг видит снимок только после взаимного согласия: запрос по коду → принять.
--   * Снимок — то, что приложение само решило показать друзьям (без разбора недели, со скрытыми пунктами).
--   * Рост базы ограничен: не больше 500 профилей, снимок до 128 КБ (≈ 64 МБ при пределе бесплатного проекта
--     500 МБ); профиль без друзей, не заходивший 14 дней, освобождает место при следующей регистрации.

create schema if not exists minimum;
revoke all on schema minimum from public;

-- ---------- таблицы

create table if not exists minimum.profiles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  secret_hash bytea not null unique,
  name        text not null,
  snapshot    jsonb,
  snapshot_at timestamptz,
  seen_at     timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint profiles_code_format check (code ~ '^[2-9A-HJ-NP-Z]{5}$'),
  constraint profiles_name_length check (char_length(name) between 1 and 40),
  constraint profiles_snapshot_object check (snapshot is null or jsonb_typeof(snapshot) = 'object')
);
create index if not exists profiles_created_at on minimum.profiles (created_at);
create index if not exists profiles_seen_at on minimum.profiles (seen_at);

-- Пара людей — одна строка: from_id отправил запрос, to_id принял (accepted).
create table if not exists minimum.links (
  from_id     uuid not null references minimum.profiles (id) on delete cascade,
  to_id       uuid not null references minimum.profiles (id) on delete cascade,
  accepted    boolean not null default false,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (from_id, to_id),
  constraint links_not_self check (from_id <> to_id)
);
create unique index if not exists links_pair on minimum.links (least(from_id, to_id), greatest(from_id, to_id));
create index if not exists links_to on minimum.links (to_id);

-- Попытки добавить по коду — против перебора кодов (не больше 20 в час).
create table if not exists minimum.attempts (
  profile_id uuid not null references minimum.profiles (id) on delete cascade,
  at         timestamptz not null default now()
);
create index if not exists attempts_profile_at on minimum.attempts (profile_id, at);
create index if not exists attempts_at on minimum.attempts (at);

-- Вторая линия защиты: даже если кто-то выдаст права на таблицы, без политик RLS строк не видно.
alter table minimum.profiles enable row level security;
alter table minimum.links enable row level security;
alter table minimum.attempts enable row level security;
revoke all on all tables in schema minimum from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema minimum from anon';
    execute 'revoke all on all tables in schema minimum from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema minimum from authenticated';
    execute 'revoke all on all tables in schema minimum from authenticated';
  end if;
end
$$;

-- ---------- служебное (снаружи недоступно)

-- Секрет → id профиля; неизвестный секрет — ошибка unknown_secret.
create or replace function minimum.auth(p_secret text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_secret is not null and char_length(p_secret) between 32 and 128 then
    select p.id into v_id
      from minimum.profiles p
     where p.secret_hash = sha256(convert_to(p_secret, 'UTF8'));
  end if;
  if v_id is null then
    raise exception 'unknown_secret' using errcode = 'P0001';
  end if;
  return v_id;
end
$$;

-- Имя для друзей: без управляющих символов, пробелы схлопнуты, 1–40 символов.
create or replace function minimum.clean_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')), 40)
$$;

-- Код друга из ввода: кириллица-двойник → латиница (русская раскладка: «К7М2Р» = «K7M2P»),
-- дальше только буквы и цифры, верхний регистр.
create or replace function minimum.clean_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(
    translate(coalesce(p_code, ''), 'АВСЕНКМОРТХУЗавсенкмортхуз', 'ABCEHKMOPTXY3ABCEHKMOPTXY3'),
    '[^0-9A-Za-z]', '', 'g'))
$$;

create or replace function minimum.me_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name)
    from minimum.profiles p
   where p.id = p_id
$$;

revoke all on function minimum.auth(text) from public;
revoke all on function minimum.clean_name(text) from public;
revoke all on function minimum.clean_code(text) from public;
revoke all on function minimum.me_json(uuid) from public;

-- ---------- API: функции для приложения

-- Регистрация устройства. Повтор с тем же секретом (ответ потерялся в сети) возвращает тот же профиль.
create or replace function public.minimum_join(p_secret text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash  bytea;
  v_name  text := minimum.clean_name(p_name);
  v_id    uuid;
  v_code  text;
  v_alpha constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_try   int := 0;
begin
  if p_secret is null or char_length(p_secret) not between 32 and 128 then
    raise exception 'bad_secret' using errcode = 'P0001';
  end if;
  if v_name = '' then
    raise exception 'bad_name' using errcode = 'P0001';
  end if;
  v_hash := sha256(convert_to(p_secret, 'UTF8'));
  select p.id into v_id from minimum.profiles p where p.secret_hash = v_hash;
  if v_id is not null then
    return minimum.me_json(v_id);
  end if;
  if (select count(*) from minimum.profiles p where p.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  -- место: профиль без друзей и запросов, не заходивший 14 дней, уступает его новому
  delete from minimum.profiles p
   where p.seen_at < now() - interval '14 days'
     and not exists (select 1 from minimum.links l where l.from_id = p.id or l.to_id = p.id);
  if (select count(*) from minimum.profiles) >= 500 then
    raise exception 'full' using errcode = 'P0001';
  end if;
  loop
    v_try := v_try + 1;
    if v_try > 20 then
      raise exception 'busy' using errcode = 'P0001';
    end if;
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * 32)::int, 1);
    end loop;
    begin
      insert into minimum.profiles (code, secret_hash, name)
      values (v_code, v_hash, v_name)
      returning id into v_id;
      return minimum.me_json(v_id);
    exception when unique_violation then
      -- занят код — пробуем другой; занят секрет — это параллельный повтор того же устройства
      select p.id into v_id from minimum.profiles p where p.secret_hash = v_hash;
      if v_id is not null then
        return minimum.me_json(v_id);
      end if;
    end;
  end loop;
end
$$;

-- Опубликовать свой снимок (фоновая отправка после отметки — без загрузки друзей).
create or replace function public.minimum_publish(p_secret text, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := minimum.auth(p_secret);
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'bad_snapshot' using errcode = 'P0001';
  end if;
  if octet_length(p_snapshot::text) > 131072 then
    raise exception 'too_large' using errcode = 'P0001';
  end if;
  update minimum.profiles
     set snapshot = p_snapshot, snapshot_at = now(), seen_at = now()
   where id = v_me;
  return jsonb_build_object('at', now());
end
$$;

-- Синхронизация: (необязательно) опубликовать снимок и получить друзей, входящие и исходящие запросы.
-- Снимки отдаются только принятым друзьям. Имя у исходящего запроса не раскрывается — только код.
create or replace function public.minimum_sync(p_secret text, p_snapshot jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := minimum.auth(p_secret);
begin
  if p_snapshot is not null then
    if jsonb_typeof(p_snapshot) <> 'object' then
      raise exception 'bad_snapshot' using errcode = 'P0001';
    end if;
    if octet_length(p_snapshot::text) > 131072 then
      raise exception 'too_large' using errcode = 'P0001';
    end if;
    update minimum.profiles
       set snapshot = p_snapshot, snapshot_at = now(), seen_at = now()
     where id = v_me;
  else
    update minimum.profiles set seen_at = now() where id = v_me;
  end if;

  return jsonb_build_object(
    'now', now(),
    'me', minimum.me_json(v_me),
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'code', p.code, 'name', p.name, 'snapshot', p.snapshot,
               'snapshotAt', p.snapshot_at, 'seenAt', p.seen_at, 'since', l.accepted_at)
             order by l.accepted_at, p.id)
        from minimum.links l
        join minimum.profiles p on p.id = case when l.from_id = v_me then l.to_id else l.from_id end
       where l.accepted and (l.from_id = v_me or l.to_id = v_me)
    ), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'at', l.created_at)
             order by l.created_at, p.id)
        from minimum.links l
        join minimum.profiles p on p.id = l.from_id
       where l.to_id = v_me and not l.accepted
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'at', l.created_at)
             order by l.created_at, p.id)
        from minimum.links l
        join minimum.profiles p on p.id = l.to_id
       where l.from_id = v_me and not l.accepted
    ), '[]'::jsonb)
  );
end
$$;

-- Запрос в друзья по коду. Ответ: sent | friends (встречный запрос — сразу друзья) | pending | already |
-- self | not_found | limit | rate_limited.
create or replace function public.minimum_request(p_secret text, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := minimum.auth(p_secret);
  v_code text := minimum.clean_code(p_code);
  v_to   uuid;
  v_link minimum.links%rowtype;
begin
  delete from minimum.attempts a where a.at < now() - interval '1 day';
  if (select count(*) from minimum.attempts a where a.profile_id = v_me and a.at > now() - interval '1 hour') >= 20 then
    return 'rate_limited';
  end if;
  insert into minimum.attempts (profile_id) values (v_me);

  if v_code !~ '^[2-9A-HJ-NP-Z]{5}$' then
    return 'not_found';
  end if;
  select p.id into v_to from minimum.profiles p where p.code = v_code;
  if v_to is null then
    return 'not_found';
  end if;
  if v_to = v_me then
    return 'self';
  end if;

  select * into v_link
    from minimum.links l
   where (l.from_id = v_me and l.to_id = v_to) or (l.from_id = v_to and l.to_id = v_me);
  if found then
    if v_link.accepted then
      return 'already';
    end if;
    if v_link.from_id = v_me then
      return 'pending';
    end if;
    -- встречный запрос уже ждёт — значит, оба хотят дружить
    update minimum.links set accepted = true, accepted_at = now()
     where from_id = v_to and to_id = v_me and not accepted;
    if found then
      return 'friends';
    end if;
    -- его только что отменили — тогда это обычный новый запрос
  end if;

  -- свои пределы: исходящие и друзья (чужие запросы к тебе не съедают твой лимит);
  -- у адресата — не больше 20 ждущих запросов, чтобы его не завалили
  if (select count(*) from minimum.links l where l.from_id = v_me or (l.to_id = v_me and l.accepted)) >= 50
     or (select count(*) from minimum.links l where l.to_id = v_to and not l.accepted) >= 20 then
    return 'limit';
  end if;

  begin
    insert into minimum.links (from_id, to_id) values (v_me, v_to);
  exception when unique_violation then
    -- встречный запрос пришёл в ту же секунду — значит, оба хотят дружить
    update minimum.links set accepted = true, accepted_at = coalesce(accepted_at, now())
     where from_id = v_to and to_id = v_me;
    if found then
      return 'friends';
    end if;
    return 'pending';
  end;
  return 'sent';
end
$$;

-- Принять входящий запрос от p_id.
create or replace function public.minimum_accept(p_secret text, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := minimum.auth(p_secret);
begin
  update minimum.links set accepted = true, accepted_at = now()
   where from_id = p_id and to_id = v_me and not accepted;
  return found;
end
$$;

-- Убрать связь с p_id в любую сторону: отклонить входящий, отменить исходящий, удалить из друзей.
create or replace function public.minimum_remove(p_secret text, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := minimum.auth(p_secret);
begin
  delete from minimum.links l
   where (l.from_id = v_me and l.to_id = p_id) or (l.from_id = p_id and l.to_id = v_me);
  return found;
end
$$;

-- Сменить имя для друзей.
create or replace function public.minimum_rename(p_secret text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := minimum.auth(p_secret);
  v_name text := minimum.clean_name(p_name);
begin
  if v_name = '' then
    raise exception 'bad_name' using errcode = 'P0001';
  end if;
  update minimum.profiles set name = v_name where id = v_me;
  return minimum.me_json(v_me);
end
$$;

-- Выключить друзей: профиль, снимок и все связи удаляются с сервера.
create or replace function public.minimum_leave(p_secret text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := minimum.auth(p_secret);
begin
  delete from minimum.profiles where id = v_me;
  return found;
end
$$;

-- ---------- права: снаружи — только функции API

revoke all on function public.minimum_join(text, text) from public;
revoke all on function public.minimum_publish(text, jsonb) from public;
revoke all on function public.minimum_sync(text, jsonb) from public;
revoke all on function public.minimum_request(text, text) from public;
revoke all on function public.minimum_accept(text, uuid) from public;
revoke all on function public.minimum_remove(text, uuid) from public;
revoke all on function public.minimum_rename(text, text) from public;
revoke all on function public.minimum_leave(text) from public;

do $$
declare
  f text;
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach f in array array[
        'public.minimum_join(text, text)', 'public.minimum_publish(text, jsonb)', 'public.minimum_sync(text, jsonb)',
        'public.minimum_request(text, text)', 'public.minimum_accept(text, uuid)', 'public.minimum_remove(text, uuid)',
        'public.minimum_rename(text, text)', 'public.minimum_leave(text)'
      ] loop
        execute format('grant execute on function %s to %I', f, r);
      end loop;
      foreach f in array array[
        'minimum.auth(text)', 'minimum.clean_name(text)', 'minimum.clean_code(text)', 'minimum.me_json(uuid)'
      ] loop
        execute format('revoke all on function %s from %I', f, r);
      end loop;
    end if;
  end loop;
end
$$;

-- PostgREST перечитывает схему, чтобы новые функции появились в API сразу.
notify pgrst, 'reload schema';
