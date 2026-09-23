-- Galleros Live Chess - dedicated Supabase schema
-- Casual chess rooms use a secret player key stored only in the player's browser.
-- Public tables expose no player secret.

create extension if not exists pgcrypto;

-- Website-only rating system: every new player starts at 1500.

create table if not exists public.chess_players (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  display_name text not null check (char_length(display_name) between 1 and 20),
  rating integer not null default 1500 check (rating between 100 and 4000),
  games integer not null default 0,
  wins integer not null default 0,
  draws integer not null default 0,
  losses integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chess_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{5,8}$'),
  white_player uuid not null references public.chess_players(id),
  black_player uuid references public.chess_players(id),
  white_name text not null,
  black_name text,
  fen text not null default 'start',
  pgn text not null default '',
  turn text not null default 'w' check (turn in ('w','b')),
  ply integer not null default 0,
  status text not null default 'waiting' check (status in ('waiting','active','white_won','black_won','draw','resigned_white','resigned_black')),
  rated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chess_moves (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.chess_rooms(id) on delete cascade,
  ply integer not null,
  player_id uuid not null references public.chess_players(id),
  color text not null check (color in ('w','b')),
  from_square text not null check (from_square ~ '^[a-h][1-8]$'),
  to_square text not null check (to_square ~ '^[a-h][1-8]$'),
  san text not null,
  fen_after text not null,
  pgn_after text not null,
  created_at timestamptz not null default now(),
  unique(room_id, ply)
);

-- Safe realtime payload: no browser/player secret is stored here.
create table if not exists public.chess_room_events (
  id bigint generated always as identity primary key,
  room_code text not null,
  event_type text not null check (event_type in ('created','joined','move','finished')),
  ply integer not null default 0,
  fen text not null default 'start',
  pgn text not null default '',
  turn text not null default 'w' check (turn in ('w','b')),
  status text not null,
  white_name text not null,
  black_name text,
  created_at timestamptz not null default now()
);

create index if not exists chess_rooms_room_code_idx on public.chess_rooms(room_code);
create index if not exists chess_moves_room_id_idx on public.chess_moves(room_id, ply);
create index if not exists chess_room_events_code_idx on public.chess_room_events(room_code, id desc);
create index if not exists chess_players_rating_idx on public.chess_players(rating desc, games desc);

create table if not exists public.chess_puzzles (
  id bigint generated always as identity primary key,
  title text not null,
  difficulty text not null check (difficulty in ('easy','medium','hard')),
  phase text not null default 'middlegame' check (phase in ('opening','middlegame','endgame')),
  fen text not null,
  solution text[] not null,
  hint text not null,
  theme text not null,
  created_at timestamptz not null default now()
);
alter table public.chess_puzzles add column if not exists phase text not null default 'middlegame';
alter table public.chess_puzzles drop constraint if exists chess_puzzles_phase_check;
alter table public.chess_puzzles add constraint chess_puzzles_phase_check check (phase in ('opening','middlegame','endgame'));

alter table public.chess_players enable row level security;
alter table public.chess_rooms enable row level security;
alter table public.chess_moves enable row level security;
alter table public.chess_room_events enable row level security;
alter table public.chess_puzzles enable row level security;

-- Only safe public data is directly readable.
drop policy if exists "public can read room events" on public.chess_room_events;
create policy "public can read room events" on public.chess_room_events
for select to anon, authenticated using (true);

drop policy if exists "public can read puzzles" on public.chess_puzzles;
create policy "public can read puzzles" on public.chess_puzzles
for select to anon, authenticated using (true);

revoke all on public.chess_players from anon, authenticated;
revoke all on public.chess_rooms from anon, authenticated;
revoke all on public.chess_moves from anon, authenticated;
grant select on public.chess_room_events to anon, authenticated;
grant select on public.chess_puzzles to anon, authenticated;

-- Upsert a casual player profile using a browser-held UUID key.
create or replace function public.chess_register_player(p_player_key uuid, p_name text)
returns table(player_id uuid, display_name text, rating integer, games integer, wins integer, draws integer, losses integer)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  kh text := encode(digest(p_player_key::text, 'sha256'), 'hex');
  pid uuid;
begin
  if p_name is null or char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 20 then
    raise exception 'Invalid player name';
  end if;
  insert into public.chess_players(key_hash, display_name)
  values (kh, trim(p_name))
  on conflict (key_hash) do update set display_name = excluded.display_name, updated_at = now()
  returning id into pid;
  return query select p.id,p.display_name,p.rating,p.games,p.wins,p.draws,p.losses from public.chess_players p where p.id=pid;
end; $$;

create or replace function public.chess_leaderboard(p_limit integer default 10)
returns table(rank bigint, display_name text, rating integer, games integer, wins integer, draws integer, losses integer)
language sql security definer
set search_path = public, pg_temp
as $$
  select row_number() over(order by p.rating desc, p.games desc, p.wins desc) as rank,
         p.display_name,p.rating,p.games,p.wins,p.draws,p.losses
  from public.chess_players p
  order by p.rating desc, p.games desc, p.wins desc
  limit greatest(1, least(coalesce(p_limit,10), 50));
$$;

create or replace function public.chess_create_room(p_player_key uuid, p_name text, p_room_code text)
returns table(room_code text, color text, white_name text, black_name text, fen text, pgn text, turn text, ply integer, status text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  kh text := encode(digest(p_player_key::text, 'sha256'), 'hex');
  pid uuid;
  code text := upper(trim(p_room_code));
  rid uuid;
begin
  if code !~ '^[A-Z0-9]{5,8}$' then raise exception 'Invalid room code'; end if;
  select p.id into pid from public.chess_players p where p.key_hash=kh;
  if pid is null then
    select r.player_id into pid from public.chess_register_player(p_player_key,p_name) r limit 1;
  end if;
  insert into public.chess_rooms(room_code,white_player,white_name)
  values(code,pid,trim(p_name)) returning id into rid;
  insert into public.chess_room_events(room_code,event_type,ply,fen,pgn,turn,status,white_name)
  values(code,'created',0,'start','','w','waiting',trim(p_name));
  return query select r.room_code,'w'::text,r.white_name,r.black_name,r.fen,r.pgn,r.turn,r.ply,r.status from public.chess_rooms r where r.id=rid;
end; $$;

create or replace function public.chess_join_room(p_player_key uuid, p_name text, p_room_code text)
returns table(room_code text, color text, white_name text, black_name text, fen text, pgn text, turn text, ply integer, status text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  kh text := encode(digest(p_player_key::text, 'sha256'), 'hex');
  pid uuid;
  code text := upper(trim(p_room_code));
  rid uuid;
begin
  select p.id into pid from public.chess_players p where p.key_hash=kh;
  if pid is null then
    select r.player_id into pid from public.chess_register_player(p_player_key,p_name) r limit 1;
  end if;
  select r.id into rid from public.chess_rooms r where r.room_code=code for update;
  if rid is null then raise exception 'Room not found'; end if;
  if exists(select 1 from public.chess_rooms r where r.id=rid and r.white_player=pid) then
    return query select r.room_code,'w'::text,r.white_name,r.black_name,r.fen,r.pgn,r.turn,r.ply,r.status from public.chess_rooms r where r.id=rid;
    return;
  end if;
  if exists(select 1 from public.chess_rooms r where r.id=rid and r.black_player is not null and r.black_player<>pid) then
    raise exception 'Room is full';
  end if;
  update public.chess_rooms set black_player=pid,black_name=trim(p_name),status='active',updated_at=now() where id=rid;
  insert into public.chess_room_events(room_code,event_type,ply,fen,pgn,turn,status,white_name,black_name)
  select room_code,'joined',ply,fen,pgn,turn,status,white_name,black_name from public.chess_rooms where id=rid;
  return query select r.room_code,'b'::text,r.white_name,r.black_name,r.fen,r.pgn,r.turn,r.ply,r.status from public.chess_rooms r where r.id=rid;
end; $$;

create or replace function public.chess_get_room(p_player_key uuid, p_room_code text)
returns table(room_code text, color text, white_name text, black_name text, fen text, pgn text, turn text, ply integer, status text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  kh text := encode(digest(p_player_key::text, 'sha256'), 'hex');
  pid uuid;
  code text := upper(trim(p_room_code));
begin
  select p.id into pid from public.chess_players p where p.key_hash=kh;
  return query
  select r.room_code,
         case when r.white_player=pid then 'w' else 'b' end::text,
         r.white_name,r.black_name,r.fen,r.pgn,r.turn,r.ply,r.status
  from public.chess_rooms r
  where r.room_code=code and pid is not null and (r.white_player=pid or r.black_player=pid);
end; $$;

create or replace function public.chess_submit_move(
  p_player_key uuid, p_room_code text, p_expected_ply integer,
  p_from text, p_to text, p_san text, p_fen text, p_pgn text, p_next_turn text
)
returns table(room_code text, color text, white_name text, black_name text, fen text, pgn text, turn text, ply integer, status text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  kh text := encode(digest(p_player_key::text, 'sha256'), 'hex');
  pid uuid; rid uuid; seat text; newply integer; code text := upper(trim(p_room_code));
begin
  select p.id into pid from public.chess_players p where p.key_hash=kh;
  if pid is null then raise exception 'Unknown player'; end if;
  select r.id, case when r.white_player=pid then 'w' when r.black_player=pid then 'b' else null end
    into rid,seat from public.chess_rooms r where r.room_code=code for update;
  if rid is null or seat is null then raise exception 'Not a room player'; end if;
  if not exists(select 1 from public.chess_rooms r where r.id=rid and r.status='active') then raise exception 'Game not active'; end if;
  if not exists(select 1 from public.chess_rooms r where r.id=rid and r.turn=seat) then raise exception 'Not your turn'; end if;
  if not exists(select 1 from public.chess_rooms r where r.id=rid and r.ply=p_expected_ply) then raise exception 'Position changed'; end if;
  if p_from !~ '^[a-h][1-8]$' or p_to !~ '^[a-h][1-8]$' or p_next_turn not in ('w','b') then raise exception 'Invalid move payload'; end if;
  newply := p_expected_ply + 1;
  insert into public.chess_moves(room_id,ply,player_id,color,from_square,to_square,san,fen_after,pgn_after)
  values(rid,newply,pid,seat,p_from,p_to,p_san,p_fen,p_pgn);
  update public.chess_rooms set fen=p_fen,pgn=p_pgn,turn=p_next_turn,ply=newply,updated_at=now() where id=rid;
  insert into public.chess_room_events(room_code,event_type,ply,fen,pgn,turn,status,white_name,black_name)
  select room_code,'move',ply,fen,pgn,turn,status,white_name,black_name from public.chess_rooms where id=rid;
  return query select r.room_code,seat,r.white_name,r.black_name,r.fen,r.pgn,r.turn,r.ply,r.status from public.chess_rooms r where r.id=rid;
end; $$;

create or replace function public.chess_finish_room(p_player_key uuid, p_room_code text, p_result text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  kh text := encode(digest(p_player_key::text, 'sha256'), 'hex');
  pid uuid; rid uuid; w uuid; b uuid; old_status text; rw int; rb int; ew numeric; eb numeric; sw numeric; sb numeric; nrw int; nrb int; code text := upper(trim(p_room_code));
begin
  if p_result not in ('white_won','black_won','draw','resigned_white','resigned_black') then raise exception 'Invalid result'; end if;
  select p.id into pid from public.chess_players p where p.key_hash=kh;
  select r.id,r.white_player,r.black_player,r.status into rid,w,b,old_status from public.chess_rooms r where r.room_code=code for update;
  if rid is null or pid is null or pid not in (w,b) then raise exception 'Not a room player'; end if;
  if old_status <> 'active' then return; end if;
  update public.chess_rooms set status=p_result,updated_at=now() where id=rid;
  if b is not null then
    select rating into rw from public.chess_players where id=w;
    select rating into rb from public.chess_players where id=b;
    ew := 1.0/(1.0+power(10.0,(rb-rw)/400.0)); eb := 1.0-ew;
    if p_result in ('white_won','resigned_black') then sw:=1; sb:=0;
    elsif p_result in ('black_won','resigned_white') then sw:=0; sb:=1;
    else sw:=0.5; sb:=0.5; end if;
    nrw := greatest(100, round(rw + 24*(sw-ew))::int);
    nrb := greatest(100, round(rb + 24*(sb-eb))::int);
    update public.chess_players set rating=nrw,games=games+1,wins=wins+(case when sw=1 then 1 else 0 end),draws=draws+(case when sw=0.5 then 1 else 0 end),losses=losses+(case when sw=0 then 1 else 0 end),updated_at=now() where id=w;
    update public.chess_players set rating=nrb,games=games+1,wins=wins+(case when sb=1 then 1 else 0 end),draws=draws+(case when sb=0.5 then 1 else 0 end),losses=losses+(case when sb=0 then 1 else 0 end),updated_at=now() where id=b;
    update public.chess_rooms set rated=true where id=rid;
  end if;
  insert into public.chess_room_events(room_code,event_type,ply,fen,pgn,turn,status,white_name,black_name)
  select room_code,'finished',ply,fen,pgn,turn,status,white_name,black_name from public.chess_rooms where id=rid;
end; $$;

revoke all on function public.chess_register_player(uuid,text) from public;
revoke all on function public.chess_leaderboard(integer) from public;
revoke all on function public.chess_create_room(uuid,text,text) from public;
revoke all on function public.chess_join_room(uuid,text,text) from public;
revoke all on function public.chess_get_room(uuid,text) from public;
revoke all on function public.chess_submit_move(uuid,text,integer,text,text,text,text,text,text) from public;
revoke all on function public.chess_finish_room(uuid,text,text) from public;
grant execute on function public.chess_register_player(uuid,text) to anon, authenticated;
grant execute on function public.chess_leaderboard(integer) to anon, authenticated;
grant execute on function public.chess_create_room(uuid,text,text) to anon, authenticated;
grant execute on function public.chess_join_room(uuid,text,text) to anon, authenticated;
grant execute on function public.chess_get_room(uuid,text) to anon, authenticated;
grant execute on function public.chess_submit_move(uuid,text,integer,text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.chess_finish_room(uuid,text,text) to anon, authenticated;

-- Sample puzzles (solution is a sequence of UCI-style moves: e2e4).
insert into public.chess_puzzles(title,difficulty,phase,fen,solution,hint,theme)
select * from (values
 ('Back Rank Mate','easy','endgame','6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',array['d1d8'],'Look at the open back rank.','Mate in 1'),
 ('Queen Finish','easy','middlegame','7k/6pp/5Q2/8/8/8/6PP/6K1 w - - 0 1',array['f6d8'],'Your queen can deliver mate.','Mate in 1'),
 ('Rook Ladder','easy','endgame','7k/6pp/8/8/8/8/5RPP/6K1 w - - 0 1',array['f2f8'],'Use the rook on the eighth rank.','Mate in 1'),
 ('Win the Queen','medium','middlegame','4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1',array['c3d5'],'A knight fork is available.','Fork'),
 ('Knight Fork','medium','middlegame','4k3/8/3q4/8/4N3/8/8/4K3 w - - 0 1',array['e4f6'],'Fork king and queen.','Fork'),
 ('Smothered Net','hard','endgame','6rk/5Qpp/7N/8/8/8/6PP/6K1 w - - 0 1',array['f7g8'],'The knight blocks escape squares.','Mate in 1')
) as v(title,difficulty,fen,solution,hint,theme)
where not exists (select 1 from public.chess_puzzles);

-- Add safe realtime events table once. Supabase may already contain it in the publication.
do $$ begin
  alter publication supabase_realtime add table public.chess_room_events;
exception when duplicate_object then null;
end $$;

-- Members directory (verified Gmail accounts only)
create or replace function public.chess_auth_member_count()
returns integer
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare c integer;
begin
  perform public.chess_require_verified_gmail();
  select count(*)::integer into c from public.chess_players where auth_user_id is not null;
  return c;
end; $$;

create or replace function public.chess_auth_members(p_query text default '')
returns table(rank bigint, player_id uuid, display_name text, rating integer, games integer, wins integer, draws integer, losses integer, joined_at timestamptz)
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare q text := trim(coalesce(p_query,''));
begin
  perform public.chess_require_verified_gmail();
  return query
  with ranked as (
    select row_number() over(order by p.rating desc,p.games desc,p.wins desc,p.created_at asc)::bigint as rnk,
           p.id,p.display_name,p.rating,p.games,p.wins,p.draws,p.losses,p.created_at
    from public.chess_players p where p.auth_user_id is not null
  )
  select r.rnk,r.id,r.display_name,r.rating,r.games,r.wins,r.draws,r.losses,r.created_at
  from ranked r
  where q='' or r.display_name ilike '%'||q||'%'
  order by r.rnk;
end; $$;

revoke all on function public.chess_auth_member_count() from public;
revoke all on function public.chess_auth_members(text) from public;
grant execute on function public.chess_auth_member_count() to authenticated;
grant execute on function public.chess_auth_members(text) to authenticated;
