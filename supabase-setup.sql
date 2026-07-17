-- Run once in Supabase Dashboard → SQL Editor for project dpildxrsuatmiywaedqg

create table if not exists public.workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;

drop policy if exists "Users read own workspace" on public.workspaces;
create policy "Users read own workspace"
  on public.workspaces for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own workspace" on public.workspaces;
create policy "Users insert own workspace"
  on public.workspaces for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own workspace" on public.workspaces;
create policy "Users update own workspace"
  on public.workspaces for update
  using (auth.uid() = user_id);
