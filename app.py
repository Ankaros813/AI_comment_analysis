from __future__ import annotations

import pandas as pd
import streamlit as st

from ai_comment_analysis.config import (
    DEFAULT_AUTHOR_SELECTOR,
    DEFAULT_COMMENT_SELECTOR,
    DEFAULT_CRAWL_MODE,
    DEFAULT_DATETIME_SELECTOR,
    DEFAULT_LLM_MODEL,
    DEFAULT_NEXT_PAGE_SELECTOR,
    RuntimeOptions,
    get_app_config,
    load_env_files,
)
from ai_comment_analysis.pipeline import run_analysis_pipeline


st.set_page_config(
    page_title="Real-time AI Comment Analyzer",
    page_icon="💬",
    layout="wide",
)


def inject_style() -> None:
    st.markdown(
        """
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap');
        :root {
            --bg-a: #f5fbf7;
            --bg-b: #e6f1ff;
            --card: #ffffffd9;
            --ink: #092331;
            --muted: #557086;
        }
        html, body, [class*="css"] { font-family: "Noto Sans KR", sans-serif; color: var(--ink); }
        .stApp {
            background:
                radial-gradient(1200px 600px at -20% -20%, #d1fae5 0%, transparent 60%),
                radial-gradient(900px 500px at 120% -10%, #ffe7cf 0%, transparent 55%),
                linear-gradient(130deg, var(--bg-a), var(--bg-b));
        }
        .hero {
            background: linear-gradient(120deg, #ffffffd9 0%, #ecfeffd9 45%, #fff7edd9 100%);
            border: 1px solid #dbeafe;
            border-radius: 20px;
            padding: 24px 26px;
            box-shadow: 0 10px 30px rgba(15, 23, 42, 0.07);
            margin-bottom: 12px;
        }
        .hero h1 { margin: 0; font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; }
        .hero p { margin: 8px 0 0 0; color: var(--muted); font-size: 0.96rem; }
        .metric-card {
            background: var(--card);
            border: 1px solid #dbeafe;
            border-radius: 16px;
            padding: 14px 16px;
            box-shadow: 0 6px 18px rgba(15, 23, 42, 0.05);
            min-height: 108px;
        }
        .metric-card .title { color: var(--muted); font-size: 0.84rem; font-weight: 600; }
        .metric-card .value { margin-top: 4px; font-size: 1.5rem; font-weight: 800; color: var(--ink); }
        .metric-card .sub { margin-top: 4px; color: var(--muted); font-size: 0.78rem; }
        .tag {
            display: inline-block;
            margin-right: 8px;
            margin-bottom: 8px;
            padding: 8px 12px;
            border-radius: 999px;
            background: #ecfeff;
            border: 1px solid #a5f3fc;
            font-size: 0.85rem;
            color: #155e75;
            font-weight: 700;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def metric_card(title: str, value: str, sub: str) -> None:
    st.markdown(
        f"""
        <div class="metric-card">
            <div class="title">{title}</div>
            <div class="value">{value}</div>
            <div class="sub">{sub}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def main() -> None:
    inject_style()
    load_env_files()

    st.markdown(
        """
        <div class="hero">
            <h1>Real-time AI Comment Analyzer</h1>
            <p>Production-oriented crawl settings: dynamic events, API mode, scope-aware checkpoints, spam/deleted filters, and PII masking.</p>
        </div>
        """,
        unsafe_allow_html=True,
    )

    with st.sidebar:
        st.subheader("Basic")
        source_url = st.text_input("Source URL", placeholder="https://example.com/post/123")
        user_query = st.text_area(
            "Analysis prompt",
            value="Analyze recent comments: sentiment, key risks, and 7-day action plan.",
            height=96,
        )
        model_name = st.text_input("LLM model", value=DEFAULT_LLM_MODEL)
        crawl_mode = st.selectbox(
            "Crawl mode",
            options=["static", "dynamic", "api_json"],
            index=["static", "dynamic", "api_json"].index(DEFAULT_CRAWL_MODE),
        )
        crawl_scope = st.text_input("Crawl scope key", value="default")
        sort_mode = st.text_input("Sort mode label", value="latest")
        max_pages = st.slider("Max pages", min_value=1, max_value=100, value=8)
        lookback_hours = st.slider("Lookback recheck hours", min_value=0, max_value=168, value=24)

        with st.expander("HTML selectors", expanded=False):
            comment_selector = st.text_input("Comment selector", value=DEFAULT_COMMENT_SELECTOR)
            author_selector = st.text_input("Author selector", value=DEFAULT_AUTHOR_SELECTOR)
            datetime_selector = st.text_input("Datetime selector", value=DEFAULT_DATETIME_SELECTOR)
            parent_selector = st.text_input("Parent selector (optional)", value="")
            next_page_selector = st.text_input("Next page selector", value=DEFAULT_NEXT_PAGE_SELECTOR)
            comment_id_attr = st.text_input("Comment ID attribute", value="data-comment-id")
            parent_id_attr = st.text_input("Parent ID attribute", value="data-parent-id")
            deleted_selector = st.text_input("Deleted marker selector", value="")
            deleted_markers_csv = st.text_input(
                "Deleted text markers(csv)",
                value="[deleted],삭제된 댓글,삭제됨,deleted by user,removed",
            )
            min_comment_length = st.number_input("Min comment length", min_value=0, max_value=100, value=2)

        with st.expander("Pagination and dynamic actions", expanded=False):
            page_param_name = st.text_input("Page query param name (e.g., page)", value="")
            page_start = st.number_input("Page start", min_value=1, max_value=9999, value=1)
            wait_for_selector = st.text_input("Wait-for selector", value="")
            consent_button_selector = st.text_input("Consent button selector", value="")
            pre_click_selectors_csv = st.text_input(
                "Pre-click selectors(csv)",
                value="",
                placeholder="button.open-comments,button.expand",
            )
            sort_button_selector = st.text_input("Sort button selector", value="")
            sort_click_times = st.number_input("Sort click times", min_value=1, max_value=10, value=1)
            load_more_selector = st.text_input("Load-more selector", value="")
            load_more_max_clicks = st.slider("Load-more max clicks", min_value=0, max_value=200, value=10)
            enable_infinite_scroll = st.toggle("Infinite scroll", value=False)
            max_scroll_steps = st.slider(
                "Scroll steps",
                min_value=1,
                max_value=200,
                value=10,
                disabled=not enable_infinite_scroll,
            )
            scroll_pause_sec = st.slider("Action wait(sec)", min_value=0.1, max_value=5.0, value=1.0, step=0.1)
            enable_shadow_dom = st.toggle("Shadow DOM extract", value=False)
            frame_selector = st.text_input("Specific iframe selector", value="")

        with st.expander("Transport / auth / retry", expanded=False):
            extra_headers_json = st.text_area("Extra headers (JSON object)", value="{}", height=90)
            cookie_string = st.text_input("Cookie string", value="", placeholder="k1=v1; k2=v2")
            auth_bearer_token = st.text_input("Bearer token", value="", type="password")
            request_delay_sec = st.slider("Request delay(sec)", min_value=0.0, max_value=3.0, value=0.2, step=0.1)
            max_retries = st.slider("Max retries", min_value=0, max_value=8, value=2)
            retry_backoff_sec = st.slider("Retry backoff base(sec)", min_value=0.1, max_value=5.0, value=1.0, step=0.1)
            default_timezone_offset_hours = st.number_input(
                "Default timezone offset(hours)",
                min_value=-12,
                max_value=14,
                value=0,
            )

        with st.expander("API mode settings", expanded=False):
            api_endpoint = st.text_input("API endpoint", value="")
            api_method = st.selectbox("API method", options=["GET", "POST"], index=0)
            api_params_json = st.text_area("API params JSON", value="{}", height=80)
            api_payload_json = st.text_area("API payload JSON", value="{}", height=80)
            api_comments_path = st.text_input("Comments path", value="data.comments")
            api_has_more_path = st.text_input("Has-more path", value="data.has_more")
            api_next_cursor_path = st.text_input("Next-cursor path", value="data.next_cursor")
            api_page_param = st.text_input("API page param", value="page")
            api_cursor_param = st.text_input("API cursor param", value="cursor")
            api_id_field = st.text_input("Comment id field", value="id")
            api_content_field = st.text_input("Content field", value="content")
            api_author_field = st.text_input("Author field", value="author")
            api_datetime_field = st.text_input("Datetime field", value="created_at")
            api_parent_id_field = st.text_input("Parent id field", value="parent_id")
            api_deleted_field = st.text_input("Deleted field", value="is_deleted")

        with st.expander("Model safety/filter", expanded=False):
            exclude_deleted_from_model = st.toggle("Exclude deleted comments", value=True)
            exclude_spam_from_model = st.toggle("Exclude spam comments", value=True)
            pii_mask_before_model = st.toggle("Mask PII before embed/LLM", value=True)
            spam_keywords_csv = st.text_input(
                "Spam keywords(csv)",
                value="무료,수익,클릭,dm,텔레그램,바카라,bit.ly,investment,casino",
            )

        use_service_role = st.toggle("Use service role key", value=True)
        analyze_clicked = st.button("Analyze", type="primary", use_container_width=True)

    if not analyze_clicked:
        st.info("Configure settings on the left and click `Analyze`.")
        return

    if not source_url.strip():
        st.error("Source URL is required.")
        st.stop()

    runtime = RuntimeOptions(
        source_url=source_url.strip(),
        user_query=user_query.strip(),
        crawl_scope=crawl_scope.strip() or "default",
        sort_mode=sort_mode.strip() or "default",
        lookback_hours=int(lookback_hours),
        max_pages=int(max_pages),
        request_delay_sec=float(request_delay_sec),
        crawl_mode=crawl_mode,
        comment_selector=comment_selector.strip(),
        author_selector=author_selector.strip(),
        datetime_selector=datetime_selector.strip(),
        parent_selector=parent_selector.strip(),
        next_page_selector=next_page_selector.strip(),
        comment_id_attr=comment_id_attr.strip(),
        parent_id_attr=parent_id_attr.strip(),
        deleted_selector=deleted_selector.strip(),
        deleted_markers_csv=deleted_markers_csv.strip(),
        page_param_name=page_param_name.strip(),
        page_start=int(page_start),
        wait_for_selector=wait_for_selector.strip(),
        consent_button_selector=consent_button_selector.strip(),
        pre_click_selectors_csv=pre_click_selectors_csv.strip(),
        sort_button_selector=sort_button_selector.strip(),
        sort_click_times=int(sort_click_times),
        load_more_selector=load_more_selector.strip(),
        load_more_max_clicks=int(load_more_max_clicks),
        enable_infinite_scroll=bool(enable_infinite_scroll),
        max_scroll_steps=int(max_scroll_steps),
        scroll_pause_sec=float(scroll_pause_sec),
        enable_shadow_dom=bool(enable_shadow_dom),
        frame_selector=frame_selector.strip(),
        extra_headers_json=extra_headers_json.strip() or "{}",
        cookie_string=cookie_string.strip(),
        auth_bearer_token=auth_bearer_token.strip(),
        max_retries=int(max_retries),
        retry_backoff_sec=float(retry_backoff_sec),
        default_timezone_offset_hours=int(default_timezone_offset_hours),
        api_endpoint=api_endpoint.strip(),
        api_method=api_method,
        api_params_json=api_params_json.strip() or "{}",
        api_payload_json=api_payload_json.strip() or "{}",
        api_comments_path=api_comments_path.strip(),
        api_has_more_path=api_has_more_path.strip(),
        api_next_cursor_path=api_next_cursor_path.strip(),
        api_page_param=api_page_param.strip(),
        api_cursor_param=api_cursor_param.strip(),
        api_id_field=api_id_field.strip(),
        api_content_field=api_content_field.strip(),
        api_author_field=api_author_field.strip(),
        api_datetime_field=api_datetime_field.strip(),
        api_parent_id_field=api_parent_id_field.strip(),
        api_deleted_field=api_deleted_field.strip(),
        exclude_deleted_from_model=bool(exclude_deleted_from_model),
        exclude_spam_from_model=bool(exclude_spam_from_model),
        pii_mask_before_model=bool(pii_mask_before_model),
        spam_keywords_csv=spam_keywords_csv.strip(),
        min_comment_length=int(min_comment_length),
    )

    with st.status("Running ingestion + retrieval + LLM analysis...", expanded=True) as status:
        st.write("1/3 incremental ingestion")
        config = get_app_config(use_service_role=use_service_role, override_model=model_name.strip())
        st.write("2/3 context retrieval")
        result = run_analysis_pipeline(
            config=config,
            runtime=runtime,
            use_service_role=use_service_role,
            model_name=model_name.strip(),
        )
        st.write("3/3 LLM summary")
        status.update(label="Done", state="complete")

    ingestion = result["ingestion"]
    sentiment_counts = result["sentiment_counts"]
    keyword_rows = result["keywords"]
    docs = result["documents"]

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        metric_card("Scanned pages", str(ingestion["pages_scanned"]), "visited page/API steps")
    with col2:
        metric_card("Found nodes", str(ingestion["comments_found"]), "raw discovered comments")
    with col3:
        metric_card("Stored docs", str(ingestion["stored_docs"]), "upserted documents")
    with col4:
        metric_card("Embedded docs", str(ingestion["embedded_docs"]), "changed + eligible docs")

    col5, col6, col7, col8 = st.columns(4)
    with col5:
        metric_card("Deleted detected", str(ingestion["deleted_detected"]), "status=deleted")
    with col6:
        metric_card("Spam detected", str(ingestion["spam_detected"]), "rule-based filter")
    with col7:
        metric_card("Unchanged embeds", str(ingestion["embedding_skipped_unchanged"]), "hash-skip optimization")
    with col8:
        metric_card("RAG docs", str(len(docs)), "docs used for model context")

    st.caption(f"crawl_mode_used={ingestion.get('crawl_mode', crawl_mode)}")
    if ingestion.get("crawl_notes"):
        st.warning(ingestion["crawl_notes"])

    st.markdown("### Sentiment distribution")
    sentiment_df = pd.DataFrame(
        {
            "sentiment": ["positive", "neutral", "negative"],
            "count": [
                sentiment_counts.get("positive", 0),
                sentiment_counts.get("neutral", 0),
                sentiment_counts.get("negative", 0),
            ],
        }
    )
    st.bar_chart(sentiment_df.set_index("sentiment"))

    st.markdown("### Top keywords")
    keyword_html = "".join(
        [f"<span class='tag'>{row['keyword']} ({row['count']})</span>" for row in keyword_rows]
    )
    st.markdown(keyword_html or "No keyword signal.", unsafe_allow_html=True)

    st.markdown("### AI analysis")
    st.markdown(result["analysis_markdown"])

    with st.expander("Retrieved comments preview"):
        preview_rows = []
        for doc in docs:
            preview_rows.append(
                {
                    "published_at": doc.get("published_at"),
                    "author": doc.get("author"),
                    "status": doc.get("status"),
                    "is_spam": doc.get("is_spam"),
                    "content": doc.get("content"),
                    "pii_masked_content": doc.get("pii_masked_content"),
                    "comment_url": doc.get("comment_url"),
                }
            )
        st.dataframe(pd.DataFrame(preview_rows), use_container_width=True)


if __name__ == "__main__":
    main()

