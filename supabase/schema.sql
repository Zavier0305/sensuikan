-- 海戦ゲーム（潜水艦）オンライン対戦版 - Supabase スキーマ
--
-- Supabase の SQL Editor でこのファイルの内容をそのまま実行してください。
-- 実行前に、Authentication > Providers で「Anonymous Sign-Ins」を有効にしておく必要があります
-- （ニックネームだけで参加できる匿名認証を使うため）。
--
-- 設計方針:
--   ・盤面は5x5（x,y は 0-4。A-E / 1-5 に対応）で、全プレイヤーが1枚を共有する。
--   ・各プレイヤーは同じ種類・耐久1の船を3隻、他人には秘密で配置する。
--   ・ships テーブルは「本人の行だけ SELECT できる」よう RLS で保護し、
--     攻撃の命中判定は SECURITY DEFINER の RPC 関数（このファイルの attack()）でのみ行う。
--     こうすることで、クライアントから直接テーブルを覗いても他人の船の位置は分からない。
--   ・rooms / room_players / ships / events への直接の INSERT/UPDATE/DELETE は許可しない
--     （ポリシーを用意しない = 既定で拒否）。すべての変更は RPC 関数経由に限定する。

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- テーブル
-- ---------------------------------------------------------------------

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  host_id uuid not null,
  current_turn uuid,
  winner_id uuid,
  created_at timestamptz not null default now()
);

-- 同時に有効なルームの中でだけコードが重複しないようにする（終了済みルームは対象外）
create unique index rooms_active_code_idx on public.rooms (code) where status <> 'finished';

create table public.room_players (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null,
  nickname text not null,
  seat int not null,
  ships_placed boolean not null default false,
  eliminated boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.ships (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms (id) on delete cascade,
  owner_id uuid not null,
  x int not null check (x between 0 and 4),
  y int not null check (y between 0 and 4),
  alive boolean not null default true
);

create table public.events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind text not null, -- join / placed / start / attack / eliminated / gameover
  actor_id uuid,
  x int,
  y int,
  hit_owner_ids uuid[] not null default '{}',
  splash_owner_ids uuid[] not null default '{}',
  message text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.ships enable row level security;
alter table public.events enable row level security;

-- room_players を自己参照すると再帰になりやすいので、
-- SECURITY DEFINER 関数（RLS をバイパスする）でメンバー判定だけ行う。
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from room_players
    where room_id = p_room_id and user_id = auth.uid()
  );
$$;

create policy rooms_select on public.rooms for select
  using (public.is_room_member(id));

create policy room_players_select on public.room_players for select
  using (public.is_room_member(room_id));

create policy events_select on public.events for select
  using (public.is_room_member(room_id));

-- 船は本人の分しか見えない（他人の配置は攻撃結果としてしか分からない）
create policy ships_select_own on public.ships for select
  using (owner_id = auth.uid());

-- INSERT/UPDATE/DELETE のポリシーはあえて作らない＝直接の書き込みは拒否。
-- すべての変更は下記の SECURITY DEFINER 関数経由でのみ行う。

-- ---------------------------------------------------------------------
-- RPC 関数
-- ---------------------------------------------------------------------

-- ルーム作成
create or replace function public.create_room(p_nickname text)
returns table (room_id uuid, code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_room_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ログインしていません';
  end if;
  if coalesce(trim(p_nickname), '') = '' then
    raise exception 'ニックネームを入力してください';
  end if;

  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
    exit when not exists (
      select 1 from rooms r where r.code = v_code and r.status <> 'finished'
    );
  end loop;

  insert into rooms (code, host_id) values (v_code, auth.uid())
    returning id into v_room_id;

  insert into room_players (room_id, user_id, nickname, seat)
    values (v_room_id, auth.uid(), trim(p_nickname), 0);

  room_id := v_room_id;
  code := v_code;
  return next;
end;
$$;

-- ルームコードで参加
create or replace function public.join_room_by_code(p_code text, p_nickname text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room rooms%rowtype;
  v_count int;
  v_seat int;
begin
  if auth.uid() is null then
    raise exception 'ログインしていません';
  end if;
  if coalesce(trim(p_nickname), '') = '' then
    raise exception 'ニックネームを入力してください';
  end if;

  select * into v_room from rooms
    where code = upper(trim(p_code)) and status = 'lobby'
    for update;

  if not found then
    raise exception 'ルームが見つからないか、すでに開始しています';
  end if;

  if exists (select 1 from room_players where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id; -- 既に参加済みなら何もしない
  end if;

  select count(*) into v_count from room_players where room_id = v_room.id;
  if v_count >= 5 then
    raise exception 'ルームが満員です（最大5人）';
  end if;

  select coalesce(max(seat), -1) + 1 into v_seat from room_players where room_id = v_room.id;

  insert into room_players (room_id, user_id, nickname, seat)
    values (v_room.id, auth.uid(), trim(p_nickname), v_seat);

  insert into events (room_id, kind, actor_id, message)
    values (v_room.id, 'join', auth.uid(), trim(p_nickname) || ' が参加しました');

  return v_room.id;
end;
$$;

-- 船を配置する（cells は [[x,y],[x,y],[x,y]] の JSON 配列で3つちょうど指定）
create or replace function public.place_ships(p_room_id uuid, p_cells jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_cell jsonb;
  v_x int;
  v_y int;
  v_seen int[] := '{}';
  v_nickname text;
begin
  if auth.uid() is null then
    raise exception 'ログインしていません';
  end if;

  select status into v_status from rooms where id = p_room_id;
  if v_status is null then
    raise exception 'ルームが存在しません';
  end if;
  if v_status <> 'lobby' then
    raise exception 'すでにゲームが開始しています';
  end if;

  select nickname into v_nickname from room_players
    where room_id = p_room_id and user_id = auth.uid();
  if v_nickname is null then
    raise exception 'このルームに参加していません';
  end if;

  if jsonb_array_length(p_cells) <> 3 then
    raise exception '3隻ちょうど配置してください';
  end if;

  delete from ships where room_id = p_room_id and owner_id = auth.uid();

  for v_cell in select * from jsonb_array_elements(p_cells) loop
    v_x := (v_cell ->> 0)::int;
    v_y := (v_cell ->> 1)::int;
    if v_x is null or v_y is null or v_x < 0 or v_x > 4 or v_y < 0 or v_y > 4 then
      raise exception '盤外のマスです';
    end if;
    if (v_x * 10 + v_y) = any (v_seen) then
      raise exception '自分の艦同士は同じマスに置けません';
    end if;
    v_seen := v_seen || (v_x * 10 + v_y);
    insert into ships (room_id, owner_id, x, y) values (p_room_id, auth.uid(), v_x, v_y);
  end loop;

  update room_players set ships_placed = true
    where room_id = p_room_id and user_id = auth.uid();

  insert into events (room_id, kind, actor_id, message)
    values (p_room_id, 'placed', auth.uid(), v_nickname || ' が配置を完了しました');
end;
$$;

-- ゲーム開始（ホストのみ、全員配置済みかつ2〜5人のときだけ）
create or replace function public.start_game(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_host uuid;
  v_status text;
  v_total int;
  v_ready int;
  v_first uuid;
  v_first_nickname text;
begin
  if auth.uid() is null then
    raise exception 'ログインしていません';
  end if;

  select host_id, status into v_host, v_status from rooms where id = p_room_id for update;
  if v_host is null then
    raise exception 'ルームが存在しません';
  end if;
  if auth.uid() <> v_host then
    raise exception 'ホストだけがゲームを開始できます';
  end if;
  if v_status <> 'lobby' then
    raise exception 'すでに開始しています';
  end if;

  select count(*), count(*) filter (where ships_placed)
    into v_total, v_ready
    from room_players where room_id = p_room_id;

  if v_total < 2 then
    raise exception '2人以上集まってから開始してください';
  end if;
  if v_total > 5 then
    raise exception '参加人数は5人までです';
  end if;
  if v_ready < v_total then
    raise exception 'まだ配置が終わっていないプレイヤーがいます';
  end if;

  -- 座席をシャッフルして手番順を決める
  with shuffled as (
    select user_id, row_number() over (order by random()) - 1 as new_seat
    from room_players where room_id = p_room_id
  )
  update room_players rp
    set seat = shuffled.new_seat
    from shuffled
    where rp.room_id = p_room_id and rp.user_id = shuffled.user_id;

  select user_id into v_first from room_players where room_id = p_room_id and seat = 0;
  select nickname into v_first_nickname from room_players
    where room_id = p_room_id and user_id = v_first;

  update rooms set status = 'playing', current_turn = v_first where id = p_room_id;

  insert into events (room_id, kind, actor_id, message)
    values (p_room_id, 'start', v_first, 'ゲーム開始！ 先手は ' || v_first_nickname || ' さんです。');
end;
$$;

-- 攻撃する（命中・水しぶき・全滅判定・手番送りをすべてここで行う）
create or replace function public.attack(p_room_id uuid, p_x int, p_y int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room rooms%rowtype;
  v_my_seat int;
  v_hit_owners uuid[];
  v_splash_owners uuid[];
  v_owner record;
  v_active_count int;
  v_next_turn uuid;
  v_winner_nickname text;
begin
  if auth.uid() is null then
    raise exception 'ログインしていません';
  end if;
  if p_x is null or p_y is null or p_x < 0 or p_x > 4 or p_y < 0 or p_y > 4 then
    raise exception '盤外のマスです';
  end if;

  select * into v_room from rooms where id = p_room_id for update;
  if not found then
    raise exception 'ルームが存在しません';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'ゲーム中ではありません';
  end if;
  if v_room.current_turn is distinct from auth.uid() then
    raise exception 'あなたの番ではありません';
  end if;

  if exists (
    select 1 from ships
    where room_id = p_room_id and owner_id = auth.uid() and alive
      and x = p_x and y = p_y
  ) then
    raise exception '自分の艦がいるマスは攻撃できません';
  end if;

  -- 命中：このマスにいる、自分以外の生存艦をすべて撃沈する
  select coalesce(array_agg(distinct owner_id), '{}') into v_hit_owners
    from ships
    where room_id = p_room_id and owner_id <> auth.uid() and alive and x = p_x and y = p_y;

  update ships set alive = false
    where room_id = p_room_id and owner_id <> auth.uid() and alive and x = p_x and y = p_y;

  -- 水しぶき：命中とは別に、このマスに隣接する生存艦を持つ他プレイヤー
  select coalesce(array_agg(distinct owner_id), '{}') into v_splash_owners
    from ships
    where room_id = p_room_id and owner_id <> auth.uid() and alive
      and greatest(abs(x - p_x), abs(y - p_y)) = 1;

  insert into events (room_id, kind, actor_id, x, y, hit_owner_ids, splash_owner_ids)
    values (p_room_id, 'attack', auth.uid(), p_x, p_y, v_hit_owners, v_splash_owners);

  -- 全滅判定
  for v_owner in
    select user_id from room_players
    where room_id = p_room_id and not eliminated and user_id <> auth.uid()
  loop
    if not exists (
      select 1 from ships where room_id = p_room_id and owner_id = v_owner.user_id and alive
    ) then
      update room_players set eliminated = true
        where room_id = p_room_id and user_id = v_owner.user_id;
      insert into events (room_id, kind, actor_id, message)
        values (
          p_room_id, 'eliminated', v_owner.user_id,
          (select nickname from room_players where room_id = p_room_id and user_id = v_owner.user_id)
            || ' は全滅しました'
        );
    end if;
  end loop;

  select count(*) into v_active_count from room_players
    where room_id = p_room_id and not eliminated;

  if v_active_count <= 1 then
    select user_id into v_next_turn from room_players
      where room_id = p_room_id and not eliminated limit 1;
    select nickname into v_winner_nickname from room_players
      where room_id = p_room_id and user_id = v_next_turn;

    update rooms set status = 'finished', winner_id = v_next_turn, current_turn = null
      where id = p_room_id;

    insert into events (room_id, kind, actor_id, message)
      values (p_room_id, 'gameover', v_next_turn, coalesce(v_winner_nickname, '???') || ' の勝利！');
  else
    select seat into v_my_seat from room_players
      where room_id = p_room_id and user_id = auth.uid();

    select user_id into v_next_turn from room_players
      where room_id = p_room_id and not eliminated and seat > v_my_seat
      order by seat asc limit 1;

    if v_next_turn is null then
      select user_id into v_next_turn from room_players
        where room_id = p_room_id and not eliminated
        order by seat asc limit 1;
    end if;

    update rooms set current_turn = v_next_turn where id = p_room_id;
  end if;
end;
$$;

grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room_by_code(text, text) to authenticated;
grant execute on function public.place_ships(uuid, jsonb) to authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.attack(uuid, int, int) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime（変更をブラウザへプッシュ配信するために必要）
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.room_players;
alter publication supabase_realtime add table public.ships;
alter publication supabase_realtime add table public.events;
