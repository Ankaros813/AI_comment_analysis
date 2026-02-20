export type CrawlMode = "auto" | "static" | "dynamic" | "api_json";
export type EmbeddingProvider = "local" | "openrouter";
export type UserTier = "general" | "pro";

export interface AnalyzeRequest {
  sourceUrl: string;
  userQuery: string;
  userTier?: UserTier;
  crawlTargetInstruction?: string;
  modelName?: string;
  embeddingProvider?: EmbeddingProvider;
  usePaidEmbedding?: boolean;
  crawlMode?: CrawlMode;
  collectionMode?: "single_page" | "list_to_posts";
  crawlScope?: string;
  sortMode?: string;
  lookbackHours?: number;
  maxPages?: number;
  maxPosts?: number;
  maxCommentPagesPerPost?: number;

  commentSelector?: string;
  authorSelector?: string;
  datetimeSelector?: string;
  parentSelector?: string;
  nextPageSelector?: string;
  listNextPageSelector?: string;
  commentNextPageSelector?: string;
  commentIdAttr?: string;
  parentIdAttr?: string;
  deletedSelector?: string;
  deletedMarkersCsv?: string;
  minCommentLength?: number;
  pageParamName?: string;
  pageStart?: number;
  postLinkSelector?: string;
  postUrlIncludes?: string;
  postUrlRegex?: string;

  apiEndpoint?: string;
  apiMethod?: "GET" | "POST";
  apiParamsJson?: string;
  apiPayloadJson?: string;
  apiCommentsPath?: string;
  apiHasMorePath?: string;
  apiNextCursorPath?: string;
  apiPageParam?: string;
  apiCursorParam?: string;
  apiIdField?: string;
  apiContentField?: string;
  apiAuthorField?: string;
  apiDatetimeField?: string;
  apiParentIdField?: string;
  apiDeletedField?: string;

  extraHeadersJson?: string;
  cookieString?: string;
  authBearerToken?: string;
  requestDelaySec?: number;
  maxRetries?: number;
  retryBackoffSec?: number;
  defaultTimezoneOffsetHours?: number;

  excludeDeletedFromModel?: boolean;
  excludeSpamFromModel?: boolean;
  piiMaskBeforeModel?: boolean;
  spamKeywordsCsv?: string;
}

export interface RuntimeConfig {
  sourceUrl: string;
  userQuery: string;
  userTier: UserTier;
  crawlTargetInstruction: string;
  modelName: string;
  embeddingProvider: EmbeddingProvider;
  crawlMode: CrawlMode;
  collectionMode: "single_page" | "list_to_posts";
  crawlScope: string;
  sortMode: string;
  lookbackHours: number;
  maxPages: number;
  maxPosts: number;
  maxCommentPagesPerPost: number;

  commentSelector: string;
  authorSelector: string;
  datetimeSelector: string;
  parentSelector: string;
  nextPageSelector: string;
  listNextPageSelector: string;
  commentNextPageSelector: string;
  commentIdAttr: string;
  parentIdAttr: string;
  deletedSelector: string;
  deletedMarkersCsv: string;
  minCommentLength: number;
  pageParamName: string;
  pageStart: number;
  postLinkSelector: string;
  postUrlIncludes: string;
  postUrlRegex: string;

  apiEndpoint: string;
  apiMethod: "GET" | "POST";
  apiParamsJson: string;
  apiPayloadJson: string;
  apiCommentsPath: string;
  apiHasMorePath: string;
  apiNextCursorPath: string;
  apiPageParam: string;
  apiCursorParam: string;
  apiIdField: string;
  apiContentField: string;
  apiAuthorField: string;
  apiDatetimeField: string;
  apiParentIdField: string;
  apiDeletedField: string;

  extraHeadersJson: string;
  cookieString: string;
  authBearerToken: string;
  requestDelaySec: number;
  maxRetries: number;
  retryBackoffSec: number;
  defaultTimezoneOffsetHours: number;

  excludeDeletedFromModel: boolean;
  excludeSpamFromModel: boolean;
  piiMaskBeforeModel: boolean;
  spamKeywordsCsv: string;
}

export interface CrawledComment {
  source_url: string;
  external_id: string;
  parent_external_id: string | null;
  content: string;
  author: string | null;
  comment_url: string;
  published_at: string | null;
  status: "active" | "deleted";
  is_spam: boolean;
  source_type: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  pii_masked_content: string;
}

export interface CrawlReport {
  pagesScanned: number;
  commentsFound: number;
  commentsFoundRaw?: number;
  commentsKept: number;
  modeUsed: string;
  notes: string;
  lastCursor?: string | null;
}

export interface CrawlInstructionPlan {
  applyFilter: boolean;
  startDate: string | null;
  endDate: string | null;
  targetCommentCount: number | null;
  recommendedMaxPages: number | null;
  recommendedLookbackHours: number | null;
  rationale: string;
}
