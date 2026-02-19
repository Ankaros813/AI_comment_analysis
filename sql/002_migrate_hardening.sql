-- Migration for existing installs created by old schema.
-- Safe to run multiple times.
create extension if not exists vector;
create extension if not exists pgcrypto;

alter table if exists public.documents add column if not exists crawl_scope text not null default 'default';
alter table if exists public.documents add column if not exists sort_mode text not null default 'default';
alter table if exists public.documents add column if not exists parent_external_id text;
alter table if exists public.documents add column if not exists pii_masked_content text not null default '';
alter table if exists public.documents add column if not exists status text not null default 'active';
alter table if exists public.documents add column if not exists is_spam boolean not null default false;
alter table if exists public.documents add column if not exists source_type text not null default 'html';
alter table if exists public.documents add column if not exists first_seen_at timestamptz not null default now();
alter table if exists public.documents add column if not exists last_seen_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema='public'
      and table_name='documents'
      and constraint_name='documents_content_hash_key'
  ) then
    alter table public.documents drop constraint documents_content_hash_key;
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema='public'
      and table_name='documents'
      and constraint_name='documents_status_check'
  ) then
    alter table public.documents
      add constraint documents_status_check check (status in ('active', 'deleted'));
  end if;
end$$;

do $$
declare
  emb_dim int;
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public' and table_name = 'comment_embeddings'
  ) then
    select (a.atttypmod - 4)
      into emb_dim
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'comment_embeddings'
      and a.attname = 'embedding'
      and a.attnum > 0
      and not a.attisdropped;

    if emb_dim is distinct from 1536 then
      drop table public.comment_embeddings cascade;
    end if;
  end if;

  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public' and table_name = 'comment_embeddings'
  ) then
    create table public.comment_embeddings (
      document_id uuid primary key references public.documents(id) on delete cascade,
      embedding vector(1536) not null,
      content_hash text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;
end$$;

alter table if exists public.comment_embeddings add column if not exists content_hash text;
alter table if exists public.comment_embeddings add column if not exists created_at timestamptz not null default now();
alter table if exists public.comment_embeddings add column if not exists updated_at timestamptz not null default now();
update public.comment_embeddings e
set content_hash = d.content_hash
from public.documents d
where e.document_id = d.id
  and (e.content_hash is null or e.content_hash = '');
alter table if exists public.comment_embeddings alter column content_hash set not null;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema='public' and table_name='crawl_state'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='crawl_state' and column_name='crawl_scope'
  ) then
    create table public.crawl_state_v2 (
      source_url text not null,
      crawl_scope text not null default 'default',
      sort_mode text not null default 'default',
      last_crawled_at timestamptz,
      last_cursor text,
      last_run_status text,
      updated_at timestamptz not null default now(),
      primary key (source_url, crawl_scope, sort_mode)
    );

    insert into public.crawl_state_v2 (source_url, crawl_scope, sort_mode, last_crawled_at, last_cursor, updated_at)
    select source_url, 'default', 'default', last_crawled_at, last_cursor, updated_at
    from public.crawl_state
    on conflict do nothing;

    drop table public.crawl_state;
    alter table public.crawl_state_v2 rename to crawl_state;
  end if;
end$$;

create index if not exists idx_documents_scope_published
    on public.documents (source_url, crawl_scope, sort_mode, published_at desc, last_seen_at desc);
create index if not exists idx_documents_status_spam
    on public.documents (source_url, status, is_spam, last_seen_at desc);
create index if not exists idx_documents_content_hash
    on public.documents (content_hash);

create index if not exists idx_embeddings_ivfflat
    on public.comment_embeddings
    using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at
before update on public.documents
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_embeddings_updated_at on public.comment_embeddings;
create trigger trg_embeddings_updated_at
before update on public.comment_embeddings
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_crawl_state_updated_at on public.crawl_state;
create trigger trg_crawl_state_updated_at
before update on public.crawl_state
for each row execute procedure public.set_updated_at();

create or replace function public.match_comment_embeddings(
    query_embedding vector(1536),
    match_source_url text,
    match_crawl_scope text default null,
    match_sort_mode text default null,
    match_count int default 20,
    filter_exclude_deleted boolean default true,
    filter_exclude_spam boolean default true
)
returns table (
    document_id uuid,
    content text,
    pii_masked_content text,
    author text,
    comment_url text,
    published_at timestamptz,
    status text,
    is_spam boolean,
    metadata jsonb,
    similarity float
)
language sql
stable
as $$
    select
        d.id as document_id,
        d.content,
        d.pii_masked_content,
        d.author,
        d.comment_url,
        d.published_at,
        d.status,
        d.is_spam,
        d.metadata,
        1 - (e.embedding <=> query_embedding) as similarity
    from public.comment_embeddings e
    join public.documents d
      on d.id = e.document_id
    where d.source_url = match_source_url
      and (match_crawl_scope is null or d.crawl_scope = match_crawl_scope)
      and (match_sort_mode is null or d.sort_mode = match_sort_mode)
      and (not filter_exclude_deleted or d.status = 'active')
      and (not filter_exclude_spam or d.is_spam = false)
    order by e.embedding <=> query_embedding
    limit greatest(match_count, 1);
$$;
