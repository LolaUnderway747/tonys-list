-- Tony's List — Supabase schema. Paste into Supabase > SQL Editor > Run (safe to run once on a fresh project).
-- One generic table of documents; the app keeps tasks/thoughts/settings/brief as paths like "tasks/<id>".

create table public.docs (
  user_id uuid    not null default auth.uid() references auth.users(id) on delete cascade,
  path    text    not null,                    -- e.g. tasks/ab12..., thoughts/cd34..., meta/settings
  data    jsonb   not null default '{}'::jsonb,
  ts      bigint  not null,                    -- ms timestamp of the edit; highest ts wins
  deleted boolean not null default false,      -- tombstone, so deletes sync to other devices
  seq     bigint  not null default 0,          -- assigned by trigger on every write; devices pull "seq > cursor"
  primary key (user_id, path)
);

create sequence public.docs_seq;

create function public.docs_set_seq() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.seq := nextval('public.docs_seq');
  return new;
end $$;

create trigger docs_seq_trg before insert or update on public.docs
  for each row execute function public.docs_set_seq();

create index docs_user_seq on public.docs (user_id, seq);

-- Row-level security: each login sees and writes only its own rows. No DELETE policy on purpose (tombstones instead).
alter table public.docs enable row level security;
create policy docs_select on public.docs for select to authenticated using (user_id = auth.uid());
create policy docs_insert on public.docs for insert to authenticated with check (user_id = auth.uid());
create policy docs_update on public.docs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Batch upsert with last-write-wins: a row is only replaced when the incoming ts is newer.
create function public.push_docs(items jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  insert into public.docs as d (user_id, path, data, ts, deleted)
  select auth.uid(), i->>'path', coalesce(i->'data', '{}'::jsonb), (i->>'ts')::bigint, coalesce((i->>'deleted')::boolean, false)
  from jsonb_array_elements(items) as i
  on conflict (user_id, path) do update
    set data = excluded.data, ts = excluded.ts, deleted = excluded.deleted
    where d.ts < excluded.ts;
  get diagnostics n = row_count;
  return n;
end $$;

-- Lock it down: only signed-in users, never the anonymous key.
revoke all on table public.docs from anon;
revoke all on function public.push_docs(jsonb) from public, anon;
grant select, insert, update on public.docs to authenticated;
grant execute on function public.push_docs(jsonb) to authenticated;
