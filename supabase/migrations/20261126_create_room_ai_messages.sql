-- Shared AI conversation storage for Ogro Nao, Ciclope.
-- Access is server-only: the Vercel API uses SUPABASE_SECRET_KEY.

create table if not exists public.room_ai_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_name text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 12000),
  created_at timestamptz not null default now()
);

create index if not exists room_ai_messages_room_created_idx
  on public.room_ai_messages (room_id, created_at, id);

alter table public.room_ai_messages enable row level security;

-- No anon/authenticated policies are created intentionally.
-- Browser clients cannot read or write this table directly.
-- The backend service-role key bypasses RLS and must never reach the frontend.
