-- Staple Sorter: Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run once on a fresh project.

-- Categories: your custom sections (Handtraps, Board Breakers, ...).
-- "position" is both the filing priority and the physical box order.
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Packages: cards that always travel together (Psy-Frame, Exodia, ...).
-- A package lives in one category, or in no category, in which case it files
-- under its lead card's type section (e.g. Main Deck Monsters).
create table if not exists public.packages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id  uuid references public.categories (id) on delete set null,
  name         text not null check (length(trim(name)) > 0),
  created_at   timestamptz not null default now()
);

-- Cards: one row per card you own (no counts), keyed by its primary passcode.
-- A card is either loose in a category, inside a package, or neither
-- (then it files under its type section). Never both a category and a package.
create table if not exists public.cards (
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  passcode          integer not null,
  category_id       uuid references public.categories (id) on delete set null,
  package_id        uuid references public.packages (id) on delete set null,
  package_position  integer,
  created_at        timestamptz not null default now(),
  primary key (user_id, passcode),
  constraint one_home check (package_id is null or category_id is null)
);

create index if not exists cards_category_idx on public.cards (category_id);
create index if not exists cards_package_idx  on public.cards (package_id);
create index if not exists packages_category_idx on public.packages (category_id);

-- Row level security: each signed-in user only ever sees and edits their own rows.
alter table public.categories enable row level security;
alter table public.packages   enable row level security;
alter table public.cards      enable row level security;

drop policy if exists "own categories" on public.categories;
create policy "own categories" on public.categories
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own packages" on public.packages;
create policy "own packages" on public.packages
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.categories, public.packages, public.cards to authenticated;
