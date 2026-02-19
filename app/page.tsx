"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

type AnalyzeResponse = {
  ingestion: {
    sinceDt: string | null;
    adjustedSinceDt: string | null;
    pagesScanned: number;
    commentsFound: number;
    commentsKept: number;
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
  modelName: "openai/gpt-oss-120b:free",
  usePaidEmbedding: false,
  crawlMode: "static",
  crawlScope: "default",
  sortMode: "latest",
  lookbackHours: 24,
  maxPages: 8,
  commentSelector: ".comment, .reply, [data-comment-id], li[class*='comment']",
  authorSelector: ".author, .user, .nickname, [class*='writer']",
  datetimeSelector: "time, .date, .time, [class*='date']",
  nextPageSelector: "a[rel='next'], .next a, a.next",
  apiEndpoint: "",
  apiMethod: "GET",
  apiCommentsPath: "data.comments",
  apiHasMorePath: "data.has_more",
  apiNextCursorPath: "data.next_cursor",
  excludeDeletedFromModel: true,
  excludeSpamFromModel: true,
  piiMaskBeforeModel: true,
};

export default function HomePage() {
  const [form, setForm] = useState<Record<string, string | number | boolean>>(DEFAULT_FORM);
  const [userTier, setUserTier] = useState<"general" | "pro">("general");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [progress, setProgress] = useState(0);

  const canSubmit = useMemo(() => {
    const hasSourceUrl = String(form.sourceUrl || "").trim().length > 0;
    const hasCrawlInstruction = String(form.crawlTargetInstruction || "").trim().length > 0;
    return hasSourceUrl && hasCrawlInstruction;
  }, [form.sourceUrl, form.crawlTargetInstruction]);

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
      if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
      setResult(json);
      setProgress(100);
    } catch (err) {
      setProgress(100);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page">
      <div className="container">        <section className="hero">
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
              Vercel + Supabase + OpenRouter 기반으로 실시간 댓글을 빠르게 수집하고 분석합니다. 크롤링 URL, 수집 조건
              자연어 지시, 분석 프롬프트를 입력해 실행할 수 있습니다.
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
                크롤링 URL (데이터 수집 대상 페이지)
              </label>
              <input
                value={String(form.sourceUrl || "")}
                onChange={(e) => setForm((s) => ({ ...s, sourceUrl: e.target.value }))}
                placeholder="https://example.com/post/123"
              />
            </div>

            <div className="field">
              <label>
                <span className="required-star" aria-hidden="true">
                  *
                </span>{" "}
                댓글 수집 조건 자연어 지시
              </label>
              <textarea
                value={String(form.crawlTargetInstruction || "")}
                onChange={(e) => setForm((s) => ({ ...s, crawlTargetInstruction: e.target.value }))}
                placeholder="예: 최근 14일 댓글 중심으로 최신순 300개를 수집해서 분석해줘."
              />
              <p className="important-note">
                분석 대상 댓글의 기간 범위와 목표 댓글 수를 구체적으로 작성해 주세요. 예: 최근 30일, 최신순 500개 중심
              </p>
            </div>

            <div className="field">
              <label>RAG 분석 프롬프트</label>
              <textarea
                value={String(form.userQuery || "")}
                onChange={(e) => setForm((s) => ({ ...s, userQuery: e.target.value }))}
                placeholder="예: 최근 댓글의 민심과 핵심 이슈, 리스크, 7일 실행 액션을 정리해줘."
              />
              <p className="muted">입력하면 해당 프롬프트를 사용하고, 비우면 기본 프롬프트를 사용합니다.</p>
            </div>

            <div className="row-2">
              <div className="field">
                <label>Model</label>
                <input
                  value={String(form.modelName || "")}
                  onChange={(e) => setForm((s) => ({ ...s, modelName: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Crawl Mode</label>
                <select
                  value={String(form.crawlMode || "static")}
                  onChange={(e) => setForm((s) => ({ ...s, crawlMode: e.target.value }))}
                >
                  <option value="static">static</option>
                  <option value="dynamic">dynamic (fallback on Vercel)</option>
                  <option value="api_json">api_json</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label>User Tier</label>
              <div className="tier-row">
                <button
                  type="button"
                  className={`tier-btn ${userTier === "general" ? "active" : ""}`}
                  onClick={() => setUserTier("general")}
                >
                  General
                </button>
                <button
                  type="button"
                  className={`tier-btn ${userTier === "pro" ? "active" : ""}`}
                  onClick={() => setUserTier("pro")}
                >
                  Pro
                </button>
              </div>
            </div>

            <div className="field">
              <label>Embedding Mode</label>
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
                    {Boolean(form.usePaidEmbedding) ? "ON: text-embedding-3-small" : "OFF: Local embedding"}
                  </strong>
                  <span>{userTier === "pro" ? "Pro can switch this on." : "General users stay in free mode."}</span>
                </div>
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label>Crawl Scope</label>
                <input
                  value={String(form.crawlScope || "")}
                  onChange={(e) => setForm((s) => ({ ...s, crawlScope: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Sort Mode</label>
                <input
                  value={String(form.sortMode || "")}
                  onChange={(e) => setForm((s) => ({ ...s, sortMode: e.target.value }))}
                />
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label>Max Pages</label>
                <input
                  type="number"
                  value={Number(form.maxPages || 8)}
                  onChange={(e) => setForm((s) => ({ ...s, maxPages: Number(e.target.value) }))}
                />
              </div>
              <div className="field">
                <label>Lookback Hours</label>
                <input
                  type="number"
                  value={Number(form.lookbackHours || 24)}
                  onChange={(e) => setForm((s) => ({ ...s, lookbackHours: Number(e.target.value) }))}
                />
              </div>
            </div>

            <details>
              <summary>HTML Selectors</summary>
              <div className="field">
                <label>Comment Selector</label>
                <input
                  value={String(form.commentSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, commentSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Author Selector</label>
                <input
                  value={String(form.authorSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, authorSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Datetime Selector</label>
                <input
                  value={String(form.datetimeSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, datetimeSelector: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Next Page Selector</label>
                <input
                  value={String(form.nextPageSelector || "")}
                  onChange={(e) => setForm((s) => ({ ...s, nextPageSelector: e.target.value }))}
                />
              </div>
            </details>

            <details>
              <summary>API Mode Settings</summary>
              <div className="field">
                <label>API Endpoint</label>
                <input
                  value={String(form.apiEndpoint || "")}
                  onChange={(e) => setForm((s) => ({ ...s, apiEndpoint: e.target.value }))}
                  placeholder="https://example.com/api/comments"
                />
              </div>
              <div className="row-2">
                <div className="field">
                  <label>API Method</label>
                  <select
                    value={String(form.apiMethod || "GET")}
                    onChange={(e) => setForm((s) => ({ ...s, apiMethod: e.target.value }))}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>
                <div className="field">
                  <label>Comments Path</label>
                  <input
                    value={String(form.apiCommentsPath || "")}
                    onChange={(e) => setForm((s) => ({ ...s, apiCommentsPath: e.target.value }))}
                  />
                </div>
              </div>
              <div className="row-2">
                <div className="field">
                  <label>Has More Path</label>
                  <input
                    value={String(form.apiHasMorePath || "")}
                    onChange={(e) => setForm((s) => ({ ...s, apiHasMorePath: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Next Cursor Path</label>
                  <input
                    value={String(form.apiNextCursorPath || "")}
                    onChange={(e) => setForm((s) => ({ ...s, apiNextCursorPath: e.target.value }))}
                  />
                </div>
              </div>
            </details>

            <details>
              <summary>Model Filters</summary>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.excludeDeletedFromModel)}
                    onChange={(e) => setForm((s) => ({ ...s, excludeDeletedFromModel: e.target.checked }))}
                  />{" "}
                  Exclude deleted comments
                </label>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.excludeSpamFromModel)}
                    onChange={(e) => setForm((s) => ({ ...s, excludeSpamFromModel: e.target.checked }))}
                  />{" "}
                  Exclude spam comments
                </label>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.piiMaskBeforeModel)}
                    onChange={(e) => setForm((s) => ({ ...s, piiMaskBeforeModel: e.target.checked }))}
                  />{" "}
                  PII mask before embedding/LLM
                </label>
              </div>
            </details>

            <button className="btn" type="submit" disabled={loading || !canSubmit}>
              {loading ? "Analyzing..." : "Analyze"}
            </button>

            {progress > 0 && (
              <div className="progress-wrap" aria-live="polite">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                  <div className="progress-text">{progress}%</div>
                </div>
              </div>
            )}

            <p className="muted">Tip: keep `maxPages` low on free tier for fast response.</p>
            {error ? <div className="error">{error}</div> : null}
          </form>

          <section className="panel">
            {!result ? (
              <p className="muted">Run analysis to see metrics, keywords, and AI summary.</p>
            ) : (
              <>
                <div className="metrics">
                  <div className="metric">
                    <div className="k">Scanned pages</div>
                    <div className="v">{result.ingestion.pagesScanned}</div>
                  </div>
                  <div className="metric">
                    <div className="k">Found comments</div>
                    <div className="v">{result.ingestion.commentsFound}</div>
                  </div>
                  <div className="metric">
                    <div className="k">Stored docs</div>
                    <div className="v">{result.ingestion.storedDocs}</div>
                  </div>
                  <div className="metric">
                    <div className="k">Embedded docs</div>
                    <div className="v">{result.ingestion.embeddedDocs}</div>
                  </div>
                  <div className="metric">
                    <div className="k">Deleted detected</div>
                    <div className="v">{result.ingestion.deletedDetected}</div>
                  </div>
                  <div className="metric">
                    <div className="k">Spam detected</div>
                    <div className="v">{result.ingestion.spamDetected}</div>
                  </div>
                  <div className="metric">
                    <div className="k">Skipped unchanged embeds</div>
                    <div className="v">{result.ingestion.embeddingSkippedUnchanged}</div>
                  </div>
                  <div className="metric">
                    <div className="k">RAG docs</div>
                    <div className="v">{result.documents.length}</div>
                  </div>
                </div>

                {result.crawlPlan && (
                  <div className="plan-box">
                    <strong>수집조건 해석 결과</strong>
                    <div className="muted">
                      start={result.crawlPlan.startDate || "null"} | end={result.crawlPlan.endDate || "null"} |
                      target={result.crawlPlan.targetCommentCount || "null"} | recommended_pages=
                      {result.crawlPlan.recommendedMaxPages || "null"}
                    </div>
                  </div>
                )}

                <p className="muted">
                  mode={result.ingestion.crawlMode}
                  {result.ingestion.crawlNotes ? ` | note=${result.ingestion.crawlNotes}` : ""}
                </p>
                <p className="muted">
                  embedding={result.ingestion.embeddingProvider || "unknown"} /{" "}
                  {result.ingestion.embeddingModel || "unknown"}
                  {` | tier=${userTier}`}
                  {result.ingestion.embeddingError ? ` | embedding_error=${result.ingestion.embeddingError}` : ""}
                </p>

                <h3>Sentiment</h3>
                <div className="chips">
                  <span className="chip">positive {result.sentimentCounts.positive}</span>
                  <span className="chip">neutral {result.sentimentCounts.neutral}</span>
                  <span className="chip">negative {result.sentimentCounts.negative}</span>
                </div>

                <h3>Top Keywords</h3>
                <div className="chips">
                  {result.keywords.map((k) => (
                    <span key={k.keyword} className="chip">
                      {k.keyword} ({k.count})
                    </span>
                  ))}
                </div>

                <h3>AI Analysis</h3>
                <div className="output">
                  <ReactMarkdown>{result.analysisMarkdown}</ReactMarkdown>
                </div>

                <h3>Retrieved Comment Preview</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>time</th>
                        <th>author</th>
                        <th>status</th>
                        <th>spam</th>
                        <th>content</th>
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
