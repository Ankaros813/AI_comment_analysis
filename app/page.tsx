"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

type AnalyzeResponse = {
  ingestion: {
    sinceDt: string | null;
    adjustedSinceDt: string | null;
    pagesScanned: number;
    commentsFound: number;
    commentsFoundRaw?: number;
    commentsKept: number;
    uniqueExternalIds?: number;
    externalIdDedupDropped?: number;
    storedDocs: number;
    embeddedDocs: number;
    embeddingSkippedUnchanged: number;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingError?: string | null;
    deletedDetected: number;
    spamDetected: number;
    crawlMode: string;
    crawlNotes: string;
    crawlInstructionApplied?: boolean;
  };
  sentimentCounts: {
    positive: number;
    neutral: number;
    negative: number;
  };
  keywords: Array<{ keyword: string; count: number }>;
  analysisMarkdown: string;
  crawlPlan?: {
    applyFilter: boolean;
    startDate: string | null;
    endDate: string | null;
    targetCommentCount: number | null;
    recommendedMaxPages: number | null;
    recommendedLookbackHours: number | null;
    rationale: string;
  } | null;
  documents: Array<Record<string, unknown>>;
};

const DEFAULT_FORM = {
  sourceUrl: "",
  userQuery: "",
  crawlTargetInstruction: "",
  modelName: "openai/gpt-4o-mini-2024-07-18",
  usePaidEmbedding: false,
  crawlMode: "auto",
  collectionMode: "single_page",
  crawlScope: "default",
  sortMode: "latest",
  lookbackHours: 24,
  maxPages: 8,
  maxPosts: 40,
  maxCommentPagesPerPost: 3,
  commentSelector: ".comment, .reply, [data-comment-id], li[class*='comment']",
  authorSelector: ".author, .user, .nickname, [class*='writer']",
  datetimeSelector: "time, .date, .time, [class*='date']",
  nextPageSelector: "a[rel='next'], .next a, a.next",
  listNextPageSelector: "a[rel='next'], .next a, a.next, .btn_next",
  commentNextPageSelector: "a[rel='next'], .next a, a.next",
  postLinkSelector: "a[href*='/board/view'], a[href*='/article/'], a[href*='/post/'], a[href*='view?']",
  postUrlIncludes: "",
  postUrlRegex: "",
  apiEndpoint: "",
  apiMethod: "GET",
  apiCommentsPath: "data.comments",
  apiHasMorePath: "data.has_more",
  apiNextCursorPath: "data.next_cursor",
  excludeDeletedFromModel: true,
  excludeSpamFromModel: true,
  piiMaskBeforeModel: true,
};

function isNaverNewsUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return /(^|\.)news\.naver\.com$/i.test(u.host) && /\/article(\/comment)?\//.test(u.pathname);
  } catch {
    return false;
  }
}

export default function HomePage() {
  const [form, setForm] = useState<Record<string, string | number | boolean>>(DEFAULT_FORM);
  const [userTier, setUserTier] = useState<"general" | "pro">("general");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [progress, setProgress] = useState(0);

  const canSubmit = useMemo(() => {
    const hasSourceUrl = String(form.sourceUrl || "").trim().length > 0;
    return hasSourceUrl;
  }, [form.sourceUrl]);

  useEffect(() => {
    if (!loading) return;
    setProgress((p) => (p < 6 ? 6 : p));
    const timer = setInterval(() => {
      setProgress((p) => {
        if (p >= 92) return 92;
        return Math.min(92, p + Math.max(1, Math.round((100 - p) / 18)));
      });
    }, 220);
    return () => clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    if (progress < 100) return;
    const timer = setTimeout(() => setProgress(0), 1200);
    return () => clearTimeout(timer);
  }, [loading, progress]);

  useEffect(() => {
    if (userTier === "pro") return;
    if (!Boolean(form.usePaidEmbedding)) return;
    setForm((s) => ({ ...s, usePaidEmbedding: false }));
  }, [form.usePaidEmbedding, userTier]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    setResult(null);
    setProgress(0);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          userTier,
        }),
      });
      const json = (await res.json()) as AnalyzeResponse & { error?: string };
      if (!res.ok) throw new Error(json.error || `요청 실패: ${res.status}`);
      setResult(json);
      setProgress(100);
    } catch (err) {
      setProgress(100);
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  };

  const applyNaverPreset = () => {
    setForm((s) => ({
      ...s,
      collectionMode: "single_page",
      sortMode: "popular",
      maxPages: Number(s.maxPages || 8),
      apiEndpoint: "https://apis.naver.com/commentBox/cbox5/web_naver_list_jsonp.json",
      apiMethod: "GET",
      apiCommentsPath: "result.commentList",
      apiHasMorePath: "result.morePage.next",
      apiNextCursorPath: "result.morePage.next",
    }));
  };

  return (
    <main className="page">
      <div className="container">
        <section className="hero">
          <div className="hero-logo" aria-hidden="true">
            <svg className="hero-logo-svg" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="heroBg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#021027" />
                  <stop offset="100%" stopColor="#001b42" />
                </linearGradient>
                <linearGradient id="heroIcon" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#63d2ff" />
                  <stop offset="100%" stopColor="#38bdf8" />
                </linearGradient>
              </defs>
              <rect x="1" y="1" width="118" height="118" rx="24" fill="url(#heroBg)" />
              <path
                d="M30 46c0-5 4-9 9-9h38c5 0 9 4 9 9v26c0 5-4 9-9 9H55l-9 8c-2 2-5 0-5-2v-6h-2c-5 0-9-4-9-9V46z"
                fill="url(#heroIcon)"
              />
              <rect x="41" y="53" width="12" height="4" rx="2" fill="#ffffff" />
              <rect x="56" y="53" width="18" height="4" rx="2" fill="#ffffff" />
              <rect x="41" y="62" width="16" height="4" rx="2" fill="#ffffff" />
              <polygon points="76,28 81,31 81,37 76,40 71,37 71,31" fill="url(#heroIcon)" />
              <polygon points="84,36 89,39 89,45 84,48 79,45 79,39" fill="url(#heroIcon)" />
              <polygon points="68,36 73,39 73,45 68,48 63,45 63,39" fill="url(#heroIcon)" />
            </svg>
          </div>
          <div className="hero-copy">
            <h1>실시간 AI 댓글 분석기</h1>
            <p>
              Vercel, Supabase, OpenRouter 기반으로 동작합니다. 소스 URL과 수집 지시문(선택), 분석 프롬프트를
              입력하면 댓글을 수집하고 AI 분석 결과를 생성합니다.
            </p>
          </div>
        </section>

        <div className="grid">
          <form className="panel" onSubmit={onSubmit}>
            <div className="field">
              <label>
                <span className="required-star" aria-hidden="true">
                  *
                </span>{" "}
                소스 URL
              </label>
              <input
                value={String(form.sourceUrl || "")}
                onChange={(e) => setForm((s) => ({ ...s, sourceUrl: e.target.value }))}
                placeholder="https://example.com/post/123"
              />
              <div className="preset-row">
                <button type="button" className="preset-btn" onClick={applyNaverPreset}>
                  네이버 프리셋
                </button>
                <span className="muted">
                  네이버 뉴스 URL은 댓글 API를 우선으로 자동 수집합니다.
                </span>
              </div>
              {isNaverNewsUrl(String(form.sourceUrl || "")) ? (
                <p className="muted">네이버 URL 감지됨: 플랫폼 API를 먼저 시도합니다.</p>
              ) : null}
            </div>

            <div className="field">
              <label>수집 지시문 (선택)</label>
              <textarea
                value={String(form.crawlTargetInstruction || "")}
                onChange={(e) => setForm((s) => ({ ...s, crawlTargetInstruction: e.target.value }))}
                placeholder="예: 최근 댓글 300개까지 수집하고 여론 흐름과 리스크를 분석해줘."
              />
            </div>

            <div className="field">
              <label>RAG 프롬프트</label>
              <textarea
                value={String(form.userQuery || "")}
                onChange={(e) => setForm((s) => ({ ...s, userQuery: e.target.value }))}
                placeholder="예: 감성 분포, 핵심 이슈, 즉시 실행 액션을 요약해줘."
              />
            </div>

            <div className="field">
              <label>모델</label>
              <input
                value={String(form.modelName || "")}
                onChange={(e) => setForm((s) => ({ ...s, modelName: e.target.value }))}
              />
            </div>
            <p className="muted">
              수집 모드는 <code>auto</code>로 고정됩니다. (API 우선 - 외부 동적 크롤러 - 정적/목록 폴백 순)
            </p>
            <p className="muted">
              JS 의존 사이트는 <code>CRAWLER_SERVICE_URL</code>에 Playwright/Puppeteer 크롤러를 연결하면
              스크롤/더보기/페이지네이션 뒤의 댓글까지 수집할 수 있습니다.
            </p>

            <div className="row-2">
              <div className="field">
                <label>
                  <span className="required-star" aria-hidden="true">
                    *
                  </span>{" "}
                  수집 모드
                </label>
                <select
                  value={String(form.collectionMode || "single_page")}
                  onChange={(e) => setForm((s) => ({ ...s, collectionMode: e.target.value }))}
                >
                  <option value="single_page">single_page (기본)</option>
                  <option value="list_to_posts">list_to_posts (목록 페이지 후 각 게시글 수집)</option>
                </select>
              </div>
              <div className="field">
                <label>최대 게시글 수 (list 모드)</label>
                <input
                  type="number"
                  value={Number(form.maxPosts || 40)}
                  onChange={(e) => setForm((s) => ({ ...s, maxPosts: Number(e.target.value) }))}
                />
              </div>
            </div>
            {String(form.collectionMode || "single_page") === "list_to_posts" ? (
              <p className="muted">
                목록 페이지에서 게시글 링크를 모은 뒤 각 게시글에 들어가 댓글을 수집합니다.
              </p>
            ) : null}

            <div className="field">
              <label>사용자 등급</label>
              <div className="tier-row">
                <button
                  type="button"
                  className={`tier-btn ${userTier === "general" ? "active" : ""}`}
                  onClick={() => setUserTier("general")}
                >
                  일반
                </button>
                <button
                  type="button"
                  className={`tier-btn ${userTier === "pro" ? "active" : ""}`}
                  onClick={() => setUserTier("pro")}
                >
                  프로
                </button>
              </div>
            </div>

            <div className="field">
              <label>임베딩 모드</label>
              <div className="toggle-row">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(form.usePaidEmbedding)}
                  aria-disabled={userTier !== "pro"}
                  disabled={userTier !== "pro"}
                  className={`switch ${Boolean(form.usePaidEmbedding) ? "on" : "off"}`}
                  onClick={() =>
                    setForm((s) => ({
                      ...s,
                      usePaidEmbedding: !Boolean(s.usePaidEmbedding),
                    }))
                  }
                >
                  <span className="switch-knob" />
                </button>
                <div className="switch-text">
                  <strong>
                    {Boolean(form.usePaidEmbedding) ? "ON: text-embedding-3-small" : "OFF: 로컬 임베딩"}
                  </strong>
                  <span>{userTier === "pro" ? "프로 등급에서 ON 설정 가능" : "일반 등급은 무료 모드 고정"}</span>
                </div>
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label>수집 범위</label>
                <input
                  value={String(form.crawlScope || "")}
                  onChange={(e) => setForm((s) => ({ ...s, crawlScope: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>정렬 모드</label>
                <input
                  value={String(form.sortMode || "")}
                  onChange={(e) => setForm((s) => ({ ...s, sortMode: e.target.value }))}
                />
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label>최대 페이지 수</label>
                <input
                  type="number"
                  value={Number(form.maxPages || 8)}
                  onChange={(e) => setForm((s) => ({ ...s, maxPages: Number(e.target.value) }))}
                />
              </div>
              <div className="field">
                <label>룩백 시간 (시간)</label>
                <input
                  type="number"
                  value={Number(form.lookbackHours || 24)}
                  onChange={(e) => setForm((s) => ({ ...s, lookbackHours: Number(e.target.value) }))}
                />
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label>게시글당 댓글 페이지 수 (list 모드)</label>
                <input
                  type="number"
                  value={Number(form.maxCommentPagesPerPost || 3)}
                  onChange={(e) => setForm((s) => ({ ...s, maxCommentPagesPerPost: Number(e.target.value) }))}
                />
              </div>
            </div>

            <details>
              <summary>HTML 셀렉터</summary>
              <div className="field">
                <label>댓글 셀렉터</label>
                <input
                  value={String(form.commentSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, commentSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>작성자 셀렉터</label>
                <input
                  value={String(form.authorSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, authorSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>날짜 셀렉터</label>
                <input
                  value={String(form.datetimeSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, datetimeSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>다음 페이지 셀렉터</label>
                <input
                  value={String(form.nextPageSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, nextPageSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>목록 다음 페이지 셀렉터 (list 모드)</label>
                <input
                  value={String(form.listNextPageSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, listNextPageSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>댓글 다음 페이지 셀렉터 (list 모드)</label>
                <input
                  value={String(form.commentNextPageSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, commentNextPageSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>게시글 링크 셀렉터 (list 모드)</label>
                <input
                  value={String(form.postLinkSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, postLinkSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>게시글 URL 포함 조건 (쉼표 구분)</label>
                <input
                  value={String(form.postUrlIncludes || "")}
                  onChange={(e) => setForm((s) => ({ ...s, postUrlIncludes: e.target.value }))}
                  placeholder="/board/view,/article/"
                />
              </div>
              <div className="field">
                <label>게시글 URL 정규식 (선택)</label>
                <input
                  value={String(form.postUrlRegex || "")}
                  onChange={(e) => setForm((s) => ({ ...s, postUrlRegex: e.target.value }))}
                  placeholder="\\/board\\/view\\/"
                />
              </div>
            </details>

            <details>
              <summary>API 모드 설정</summary>
              <div className="field">
                <label>API 엔드포인트</label>
                <input
                  value={String(form.apiEndpoint || "")}
                  onChange={(e) => setForm((s) => ({ ...s, apiEndpoint: e.target.value }))}
                  placeholder="https://example.com/api/comments"
                />
              </div>
              <div className="row-2">
                <div className="field">
                  <label>API 메서드</label>
                  <select
                    value={String(form.apiMethod || "GET")}
                    onChange={(e) => setForm((s) => ({ ...s, apiMethod: e.target.value }))}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>
                <div className="field">
                  <label>댓글 경로</label>
                  <input
                    value={String(form.apiCommentsPath || "")}
                    onChange={(e) => setForm((s) => ({ ...s, apiCommentsPath: e.target.value }))}
                  />
                </div>
              </div>
              <div className="row-2">
                <div className="field">
                  <label>추가 페이지 여부 경로</label>
                  <input
                    value={String(form.apiHasMorePath || "")}
                    onChange={(e) => setForm((s) => ({ ...s, apiHasMorePath: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>다음 커서 경로</label>
                  <input
                    value={String(form.apiNextCursorPath || "")}
                    onChange={(e) => setForm((s) => ({ ...s, apiNextCursorPath: e.target.value }))}
                  />
                </div>
              </div>
            </details>

            <details>
              <summary>모델 필터</summary>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.excludeDeletedFromModel)}
                    onChange={(e) => setForm((s) => ({ ...s, excludeDeletedFromModel: e.target.checked }))}
                  />{" "}
                  삭제 댓글 제외
                </label>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.excludeSpamFromModel)}
                    onChange={(e) => setForm((s) => ({ ...s, excludeSpamFromModel: e.target.checked }))}
                  />{" "}
                  스팸 댓글 제외
                </label>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.piiMaskBeforeModel)}
                    onChange={(e) => setForm((s) => ({ ...s, piiMaskBeforeModel: e.target.checked }))}
                  />{" "}
                  임베딩/LLM 전 개인정보 마스킹
                </label>
              </div>
            </details>

            <button className="btn" type="submit" disabled={loading || !canSubmit}>
              {loading ? "분석 중..." : "분석 시작"}
            </button>

            {progress > 0 && (
              <div className="progress-wrap" aria-live="polite">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                  <div className="progress-text">{progress}%</div>
                </div>
              </div>
            )}

            <p className="muted">팁: 무료 티어에서는 빠른 응답을 위해 `maxPages`를 낮게 유지하세요.</p>
            {error ? <div className="error">{error}</div> : null}
          </form>

          <section className="panel">
            {!result ? (
              <p className="muted">분석을 실행하면 수집 지표, 키워드, AI 요약이 표시됩니다.</p>
            ) : (
              <>
                <div className="metrics">
                  <div className="metric">
                    <div className="k">스캔한 페이지</div>
                    <div className="v">{result.ingestion.pagesScanned}</div>
                  </div>
                  <div className="metric">
                    <div className="k">수집 댓글 (고유)</div>
                    <div className="v">{result.ingestion.commentsFound}</div>
                  </div>
                  <div className="metric">
                    <div className="k">수집 행 (원본)</div>
                    <div className="v">{result.ingestion.commentsFoundRaw ?? result.ingestion.commentsFound}</div>
                  </div>
                  <div className="metric">
                    <div className="k">고유 ID 수</div>
                    <div className="v">{result.ingestion.uniqueExternalIds ?? result.ingestion.commentsKept}</div>
                  </div>
                  <div className="metric">
                    <div className="k">저장 문서 수</div>
                    <div className="v">{result.ingestion.storedDocs}</div>
                  </div>
                  <div className="metric">
                    <div className="k">임베딩 문서 수</div>
                    <div className="v">{result.ingestion.embeddedDocs}</div>
                  </div>
                  <div className="metric">
                    <div className="k">삭제 감지 수</div>
                    <div className="v">{result.ingestion.deletedDetected}</div>
                  </div>
                  <div className="metric">
                    <div className="k">스팸 감지 수</div>
                    <div className="v">{result.ingestion.spamDetected}</div>
                  </div>
                  <div className="metric">
                    <div className="k">임베딩 스킵 수</div>
                    <div className="v">{result.ingestion.embeddingSkippedUnchanged}</div>
                  </div>
                  <div className="metric">
                    <div className="k">RAG 문서 수</div>
                    <div className="v">{result.documents.length}</div>
                  </div>
                </div>

                {result.crawlPlan && (
                  <div className="plan-box">
                    <strong>수집 지시 해석 결과</strong>
                    <div className="muted">
                      시작={result.crawlPlan.startDate || "null"} | 종료={result.crawlPlan.endDate || "null"} |
                      목표={result.crawlPlan.targetCommentCount || "null"} | 권장_페이지=
                      {result.crawlPlan.recommendedMaxPages || "null"}
                    </div>
                  </div>
                )}

                <p className="muted">
                  모드={result.ingestion.crawlMode}
                  {result.ingestion.crawlNotes ? ` | 메모=${result.ingestion.crawlNotes}` : ""}
                  {typeof result.ingestion.externalIdDedupDropped === "number"
                    ? ` | 중복제거=${result.ingestion.externalIdDedupDropped}`
                    : ""}
                </p>
                <p className="muted">
                  임베딩={result.ingestion.embeddingProvider || "unknown"} /{" "}
                  {result.ingestion.embeddingModel || "unknown"}
                  {` | 등급=${userTier}`}
                  {result.ingestion.embeddingError ? ` | 임베딩오류=${result.ingestion.embeddingError}` : ""}
                </p>

                <h3>감성 분포</h3>
                <div className="chips">
                  <span className="chip">긍정 {result.sentimentCounts.positive}</span>
                  <span className="chip">중립 {result.sentimentCounts.neutral}</span>
                  <span className="chip">부정 {result.sentimentCounts.negative}</span>
                </div>

                <h3>주요 키워드</h3>
                <div className="chips">
                  {result.keywords.map((k) => (
                    <span key={k.keyword} className="chip">
                      {k.keyword} ({k.count})
                    </span>
                  ))}
                </div>

                <h3>AI 분석</h3>
                <div className="output">
                  <ReactMarkdown>{result.analysisMarkdown}</ReactMarkdown>
                </div>

                <h3>수집 댓글 미리보기</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>시간</th>
                        <th>작성자</th>
                        <th>상태</th>
                        <th>스팸</th>
                        <th>내용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.documents.map((row, idx) => (
                        <tr key={idx}>
                          <td>{String(row.published_at || "")}</td>
                          <td>{String(row.author || "")}</td>
                          <td>{String(row.status || "")}</td>
                          <td>{String(row.is_spam || "")}</td>
                          <td>{String(row.pii_masked_content || row.content || "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

