# Vercel 무료 배포 가이드

## 1) 배포 시작
아래 링크로 바로 새 프로젝트 생성 화면 진입:
- `https://vercel.com/new?teamSlug=woo-seok-jeongs-projects`

GitHub 연결된 상태라면, `AI_comment_analysis` 레포(또는 폴더) 선택 후 배포하면 됩니다.

## 2) Vercel 프로젝트 설정
- Framework Preset: `Next.js`
- Build Command: 기본값 사용
- Output: 기본값 사용
- Root Directory:
  - 레포 루트가 `AI_comment_analysis` 자체면 그대로
  - 상위 레포 안 하위 폴더라면 Root Directory를 `AI_comment_analysis`로 지정

## 3) 환경변수 등록 (Vercel Project > Settings > Environment Variables)
- `OPENROUTER_HACKERTHON_API_KEY`
- `SUPABASE_HACKERTHON_URL`
- `SUPABASE_HACKERTHON_SERVICE_ROLE_KEY`
- (선택) `COMMENT_TOP_K`
- (선택) `COMMENT_MAX_CONTEXT_CHARS`
- (선택) `COMMENT_REQUEST_TIMEOUT_SEC`
- (선택) `COMMENT_EMBEDDING_MODEL` (default: `openai/text-embedding-3-small`)
- (선택) `COMMENT_EMBEDDING_DIM` (default: `1536`)

## 4) Supabase SQL 실행
- 신규: `sql/001_init_tables.sql`
- 기존 스키마 업그레이드: `sql/002_migrate_hardening.sql`

## 5) 무료 운영 팁
- `maxPages`를 낮게 유지 (예: 3~10)
- `lookbackHours`는 과도하게 크게 잡지 않기
- `dynamic` 모드는 Vercel 서버리스 제약으로 `static` 폴백됨
- API형 댓글이면 `api_json` 모드를 우선 사용
- 임베딩은 로컬 해시이므로 과금 없음, 사실상 LLM 호출에만 비용 집중

## Embedding Mode (Latest)
- Default provider is free local embedding.
- Turn on paid embeddings from the UI toggle or env.
- Optional env:
  - `COMMENT_EMBEDDING_PROVIDER=local|openrouter`
  - `COMMENT_USE_PAID_EMBEDDING=1`
  - `COMMENT_EMBEDDING_MODEL=openai/text-embedding-3-small`
  - `COMMENT_EMBEDDING_DIM=1536`
