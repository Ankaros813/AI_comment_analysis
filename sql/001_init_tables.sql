-- Supabase SQL (fresh install)
create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.documents (
    id uuid primary key default gen_random_uuid(),
    source_url text not null,
    crawl_scope text not null default 'default',
    sort_mode text not null default 'default',
    external_id text not null,
    parent_external_id text,
    content text not null,
    pii_masked_content text not null default '',
    author text,
    comment_url text,
    published_at timestamptz,
    status text not null default 'active',
    is_spam boolean not null default false,
    source_type text not null default 'html',
    metadata jsonb not null default '{}'::jsonb,
    content_hash text not null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (source_url, external_id),
    constraint documents_status_check check (status in ('active', 'deleted'))
);

create table if not exists public.comment_embeddings (
    document_id uuid primary key references public.documents(id) on delete cascade,
    embedding vector(1536) not null,
    content_hash text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.crawl_state (
    source_url text not null,
    crawl_scope text not null default 'default',
    sort_mode text not null default 'default',
    last_crawled_at timestamptz,
    last_cursor text,
    last_run_status text,
    updated_at timestamptz not null default now(),
    primary key (source_url, crawl_scope, sort_mode)
);

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
