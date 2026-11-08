-- 问津公网页面 · Supabase schema（幂等）
create table if not exists cases (
  case_id text primary key,
  domain text, kind text, tech text, institution text,
  claimed text, claimed_wording text, outcome text, blocking_evidence text,
  gate_organiser text, duration_years text, evidence_level text,
  prewarning text, maps_to_mode text, maps_to_dim text, clears_gap text,
  source_url text, published_at text, retrieved_at text, quote text,
  verification_status text, note text
);
create table if not exists cases_extra (
  case_id text primary key,
  title text not null, domain text not null, kind text not null,
  tech text, institution text, claimed text, claimed_wording text,
  outcome text, gate text, evidence_level text, maps_to text,
  blocking text, source_url text not null, quote text not null, quote2 text,
  published_at text, retrieved_at text not null, access_status text,
  verification_status text, note text, batch text, created_at text not null
);
create table if not exists guides (
  topic text primary key,
  ord int,
  title text, question text, summary text,
  typical_evidence jsonb, pitfalls jsonb, next_steps jsonb,
  case_ids jsonb, anchors jsonb
);
create table if not exists links (
  url text primary key,
  ord int,
  "group" text, name text, purpose text, status text, note text
);
create table if not exists case_link_status (
  case_id text primary key,
  status int, final_url text, url text, kind text, checked_at text
);
create table if not exists analyses (
  request_id text primary key,
  created_at timestamptz not null default now(),
  case_title text, stage text, input_chars int,
  target_use text, source_url text,
  app_version text, rule_version text,
  result jsonb not null,
  client text not null default 'pages'
);
alter table cases enable row level security;
alter table cases_extra enable row level security;
alter table guides enable row level security;
alter table links enable row level security;
alter table case_link_status enable row level security;
alter table analyses enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='cases' and policyname='cases_read') then
    create policy cases_read on cases for select to anon using (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='cases_extra' and policyname='cases_extra_read') then
    create policy cases_extra_read on cases_extra for select to anon using (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='guides' and policyname='guides_read') then
    create policy guides_read on guides for select to anon using (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='links' and policyname='links_read') then
    create policy links_read on links for select to anon using (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='case_link_status' and policyname='case_link_status_read') then
    create policy case_link_status_read on case_link_status for select to anon using (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='analyses' and policyname='analyses_insert') then
    create policy analyses_insert on analyses for insert to anon with check (true);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='analyses' and policyname='analyses_read') then
    create policy analyses_read on analyses for select to anon using (true);
  end if;
end $$;
