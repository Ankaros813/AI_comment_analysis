# AI Comment Analysis (Vercel Edition)

실시간 댓글 분석 앱을 **Vercel 무료 플랜** 기준으로 실행/배포할 수 있게 구성한 버전입니다.

## 핵심 구성
- Frontend/App: Next.js (`app/page.tsx`)
- Backend API: Next.js Route Handler (`app/api/analyze/route.ts`)
- DB: Supabase (`documents`, `comment_embeddings_384`, `comment_embeddings_1536`, `crawl_state`)
- LLM: OpenRouter (`openai/gpt-4o-mini-2024-07-18` 기본)
- 비용 최적화:
  - 임베딩은 로컬 해시(무료)
  - 변경된 문서만 재임베딩
  - 증분 크롤링 + lookback 재검사

## 지원 크롤링 모드
- `static`: 일반 HTML 댓글
- `api_json`: 내부 API/XHR 댓글
- `dynamic`: Vercel 서버리스에서 브라우저 자동화 제한이 있어 자동으로 `static` 폴백
- `naver article auto`: 네이버 기사 URL(`n.news.naver.com/article/...`)이면 서버가 자동으로
  네이버 댓글 API(JSONP)를 사용해 본댓글/대댓글/더보기 페이지를 순회 수집

## Collection Mode
- `single_page` (기본): 입력한 URL 페이지의 댓글만 수집
- `list_to_posts`: 목록 페이지에서 게시글 링크를 모은 뒤 각 게시글로 들어가 댓글 수집
  - 주요 필드: `postLinkSelector`, `listNextPageSelector`, `commentNextPageSelector`, `maxPosts`

## UI 주요 입력
- 크롤링 URL 입력란
- 네이버 뉴스 자동설정 버튼
  - `api_json` 관련 필드 자동 주입
  - 네이버 URL일 때는 서버가 전용 수집 경로로 처리
- 댓글 수집 조건 자연어 지시 입력란
  - 날짜 기간, 목표 댓글 개수를 문장으로 입력
  - 해당 문장을 별도 LLM 호출로 해석하여 수집 필터에 반영
- RAG 분석 프롬프트 입력란
- 분석 진행률 게이지 바(연회색 트랙 + 녹색 진행 + 중앙 퍼센트 표시)

## 폴더
```
AI_comment_analysis/
  app/
    api/analyze/route.ts
    globals.css
    layout.tsx
    page.tsx
  lib/
    analysis.ts
    crawler.ts
    embedding.ts
    supabase.ts
    text-ops.ts
    types.ts
  sql/
    001_init_tables.sql
    002_migrate_hardening.sql
  package.json
  vercel.json
```

## 필수 환경변수
Vercel Project Environment Variables:
- `OPENROUTER_HACKERTHON_API_KEY`
- `SUPABASE_HACKERTHON_URL`
- `SUPABASE_HACKERTHON_SERVICE_ROLE_KEY`

선택:
- `COMMENT_TOP_K` (기본 24)
- `COMMENT_MAX_CONTEXT_CHARS` (기본 14000)
- `COMMENT_REQUEST_TIMEOUT_SEC` (기본 45)
- `COMMENT_EMBEDDING_MODEL` (기본 `openai/text-embedding-3-small`)
- `COMMENT_EMBEDDING_DIM` (기본 `1536`)

로컬 실행 시에는 `AI_comment_analysis/.env.local` 파일에 동일 키를 넣어야 합니다.

## DB 준비
1. 신규 프로젝트: `sql/001_init_tables.sql` 실행  
2. 예전 스키마에서 업그레이드: `sql/002_migrate_hardening.sql` 실행  

바탕화면 빠른 복사용:
- `AI_comment_analysis_supabase.sql`
- `AI_comment_analysis_supabase_migration.sql`

## 로컬 실행
```bash
npm install
npm run dev
```
## Embedding Model
- Provider: OpenRouter Embeddings API
- Default model: `openai/text-embedding-3-small`
- Vector dimension: `1536` (must match Supabase `vector(1536)`)
- Optional env:
  - `COMMENT_EMBEDDING_MODEL`
  - `COMMENT_EMBEDDING_DIM` (default `1536`)
브라우저: `http://localhost:3000`

## Embedding Mode (Latest)
- Default: `local` (free hash embedding, no embedding API billing)
- Paid option: `openrouter` with `openai/text-embedding-3-small`
- UI toggle: `Use paid embeddings`
- Embedding storage:
  - local -> `comment_embeddings_384`
  - openrouter -> `comment_embeddings_1536`
- Optional env:
  - `COMMENT_EMBEDDING_PROVIDER=local|openrouter`
  - `COMMENT_USE_PAID_EMBEDDING=1` (forces paid embedding)
  - `COMMENT_EMBEDDING_MODEL=openai/text-embedding-3-small`
  - `COMMENT_EMBEDDING_DIM=384|1536` (local only; openrouter path is fixed to 1536)

## External Dynamic Crawler
- UI crawl mode is fixed to `auto`.
- For dynamic pages (JS render, infinite scroll, more buttons), run an external Playwright crawler service.
- Set Vercel env:
  - `CRAWLER_SERVICE_URL=https://<your-service>/crawl`
  - `CRAWLER_SERVICE_TOKEN=<token>` (optional)
- See:
  - `external_crawler_service/README.md`
  - `EXTERNAL_CRAWLER_SETUP.md`
