const crypto = require("crypto");
const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const PORT = toInt(process.env.PORT, 8080, 1, 65535);
const NAV_TIMEOUT_MS = toInt(process.env.NAV_TIMEOUT_MS, 30000, 3000, 120000);
const MAX_INTERACTION_PASSES = toInt(process.env.MAX_INTERACTION_PASSES, 8, 1, 40);
const INTERACTION_DELAY_MS = toInt(process.env.INTERACTION_DELAY_MS, 700, 100, 8000);
const TOKEN = String(process.env.CRAWLER_SERVICE_TOKEN || "").trim();

const MORE_HINTS = [
  "more",
  "load more",
  "show more",
  "view more",
  "expand",
  "see more",
  "reply",
  "replies",
  "comment more",
  "\ub313\uae00 \ub354\ubcf4\uae30",
  "\ub354\ubcf4\uae30",
  "\ub354 \ubcf4\uae30",
  "\ud3bc\uce58\uae30",
  "\ub2f5\uae00",
  "\ub2f5\uae00 \ub354\ubcf4\uae30",
].map((v) => v.toLowerCase());

const NEXT_HINTS = [
  "next",
  "\ub2e4\uc74c",
  ">",
  "\u203a",
  "\u2192",
  "\ub2e4\uc74c\ud398\uc774\uc9c0",
  "\ub2e4\uc74c \ud398\uc774\uc9c0",
].map((v) => v.toLowerCase());

const DEFAULT_SELECTORS = {
  comment: ".comment, .reply, [data-comment-id], li[class*='comment']",
  author: ".author, .user, .nickname, [class*='writer']",
  datetime: "time, .date, .time, [class*='date']",
  next: "a[rel='next'], .next a, a.next, .btn_next",
  postLink: "a[href*='/board/view'], a[href*='/article/'], a[href*='/post/'], a[href*='view?']",
  listNext: "a[rel='next'], .next a, a.next, .btn_next",
  commentNext: "a[rel='next'], .next a, a.next, .btn_next",
};

function toInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  return Math.max(min, Math.min(max, t));
}

function normalizeText(v) {
  return String(v || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function stableHash(v) {
  return crypto.createHash("sha1").update(String(v)).digest("hex");
}

function isNavigationContextError(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  return (
    msg.includes("execution context was destroyed") ||
    msg.includes("most likely because of a navigation") ||
    msg.includes("cannot find context")
  );
}

function mergeSelectors(input) {
  const out = { ...DEFAULT_SELECTORS };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const key of Object.keys(out)) {
    const raw = input[key];
    if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
  }
  return out;
}

function normalizeCommentRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const content = normalizeText(row.content || "");
    if (!content) continue;
    const author = normalizeText(row.author || "");
    const datetime = normalizeText(row.datetime || row.published_at || "");
    const commentUrl = normalizeText(row.comment_url || "");
    const rawId = normalizeText(row.external_id || "");
    const dedupKey = rawId || stableHash(`${commentUrl}|${author}|${datetime}|${content}`);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      external_id: rawId || dedupKey,
      parent_external_id: normalizeText(row.parent_external_id || "") || null,
      content,
      author: author || null,
      datetime: datetime || null,
      published_at: datetime || null,
      comment_url: commentUrl || null,
      status: normalizeText(row.status || "").toLowerCase() === "deleted" ? "deleted" : "active",
    });
  }
  return out;
}

async function gotoPage(page, url) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(Math.min(1200, INTERACTION_DELAY_MS + 300));
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
      await page.waitForTimeout(900);
    }
  }
}

async function clickBySelector(page, selector) {
  if (!selector) return false;
  try {
    const clicked = await page.evaluate((sel) => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return true;
      };

      let el = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (!el || !isVisible(el)) return false;
      if (el.hasAttribute("disabled")) return false;
      const node = el.closest("button,a,[role='button'],input[type='button'],input[type='submit']") || el;
      if (typeof node.click === "function") node.click();
      return true;
    }, selector);
    return Boolean(clicked);
  } catch {
    return false;
  }
}

async function clickByHints(page, hints, maxClicks = 1) {
  try {
    const count = await page.evaluate(
      ({ localHints, localMaxClicks }) => {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = window.getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") return false;
          return true;
        };

        const labelOf = (el) =>
          String(
            el.innerText ||
              el.textContent ||
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.value ||
              "",
          )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const blockHints = ["\ub85c\uadf8\uc778", "login", "share", "\uacf5\uc720", "\uc124\uc815"];
        const nodes = Array.from(
          document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit'],span,div"),
        );

        let clicked = 0;
        for (const rawNode of nodes) {
          if (clicked >= localMaxClicks) break;
          const node = rawNode.closest("button,a,[role='button'],input[type='button'],input[type='submit']") || rawNode;
          const label = labelOf(node);
          if (!label || label.length > 60) continue;
          if (!localHints.some((h) => label.includes(h))) continue;
          if (blockHints.some((h) => label.includes(h.toLowerCase()))) continue;
          if (!isVisible(node)) continue;
          if (node.hasAttribute("disabled")) continue;

          if (node.tagName === "A") {
            const href = String(node.getAttribute("href") || "")
              .replace(/\s+/g, "")
              .toLowerCase();
            const inPageAction =
              !href || href === "#" || href.startsWith("javascript:") || href.startsWith("void(");
            if (!inPageAction) continue;
          }

          if (typeof node.click === "function") {
            node.click();
            clicked += 1;
          }
        }
        return clicked;
      },
      { localHints: hints.map((v) => v.toLowerCase()), localMaxClicks: maxClicks },
    );
    return Number(count || 0);
  } catch {
    return 0;
  }
}

async function autoScroll(page) {
  let stagnant = 0;
  for (let i = 0; i < 4; i += 1) {
    try {
      const before = await page.evaluate(() => (document.body ? document.body.scrollHeight : 0));
      await page.evaluate(() => window.scrollTo(0, document.body ? document.body.scrollHeight : 0));
      await page.waitForTimeout(INTERACTION_DELAY_MS);
      const after = await page.evaluate(() => (document.body ? document.body.scrollHeight : 0));
      if (after <= before + 2) stagnant += 1;
      else stagnant = 0;
      if (stagnant >= 2) break;
    } catch (err) {
      if (!isNavigationContextError(err)) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(300);
    }
  }
}

async function expandAndScroll(page) {
  let noChangePasses = 0;
  for (let pass = 0; pass < MAX_INTERACTION_PASSES; pass += 1) {
    const clicked = await clickByHints(page, MORE_HINTS, 24);
    await autoScroll(page);
    if (clicked === 0) noChangePasses += 1;
    else noChangePasses = 0;
    if (noChangePasses >= 2) break;
  }
}

async function extractComments(page, selectors) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate((sel) => {
        const normalize = (v) =>
          String(v || "")
            .replace(/\s+/g, " ")
            .trim();

        const safeQuery = (root, selector) => {
          if (!selector) return null;
          try {
            return root.querySelector(selector);
          } catch {
            return null;
          }
        };

        const pickDate = (node, dateSelector) => {
          const d = safeQuery(node, dateSelector);
          if (!d) return "";
          return normalize(d.getAttribute("datetime") || d.getAttribute("title") || d.textContent || "");
        };

        const pickAuthor = (node, authorSelector) => {
          const a = safeQuery(node, authorSelector);
          if (!a) return "";
          return normalize(a.textContent || "");
        };

        let nodes = [];
        try {
          nodes = Array.from(document.querySelectorAll(sel.comment || ""));
        } catch {
          nodes = [];
        }

        const rows = [];
        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          const content = normalize(node.innerText || node.textContent || "");
          if (!content || content.length < 2) continue;

          const author = pickAuthor(node, sel.author);
          const datetime = pickDate(node, sel.datetime);
          const externalId = normalize(
            node.getAttribute("data-comment-id") ||
              node.getAttribute("data-id") ||
              node.getAttribute("id") ||
              node.id ||
              "",
          );
          const parentId = normalize(
            node.getAttribute("data-parent-id") || node.getAttribute("data-parent-comment-id") || "",
          );
          const status = /(^|\s)(deleted|removed|\uc0ad\uc81c\ub41c \ub313\uae00|\uc0ad\uc81c\ub428)/i.test(content)
            ? "deleted"
            : "active";

          rows.push({
            external_id: externalId || null,
            parent_external_id: parentId || null,
            content,
            author: author || null,
            datetime: datetime || null,
            published_at: datetime || null,
            comment_url: location.href,
            status,
          });
        }
        return rows;
      }, selectors);
    } catch (err) {
      if (!isNavigationContextError(err)) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(350);
    }
  }
  return [];
}

async function clickNext(page, selector) {
  const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => null);
  let clicked = false;

  clicked = await clickBySelector(page, selector);
  if (!clicked) {
    const hintClickCount = await clickByHints(page, NEXT_HINTS, 1);
    clicked = hintClickCount > 0;
  }
  if (!clicked) return false;

  await Promise.race([navPromise, page.waitForTimeout(INTERACTION_DELAY_MS + 500)]);
  await page.waitForTimeout(INTERACTION_DELAY_MS);
  return true;
}

async function crawlCommentsInOpenedPage(page, selectors, maxPages) {
  const rawRows = [];
  let pagesScanned = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    await expandAndScroll(page);
    const rows = await extractComments(page, selectors);
    rawRows.push(...rows);
    pagesScanned += 1;

    if (pageNo >= maxPages) break;
    const moved = await clickNext(page, selectors.commentNext || selectors.next);
    if (!moved) break;
  }

  return { rawRows, pagesScanned };
}

async function extractPostLinks(page, selector) {
  if (!selector) return [];
  try {
    const links = await page.evaluate((sel) => {
      const out = [];
      const seen = new Set();
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch {
        nodes = [];
      }

      for (const node of nodes) {
        const href = node.getAttribute && node.getAttribute("href");
        if (!href) continue;
        try {
          const abs = new URL(href, location.href).toString();
          if (!/^https?:\/\//i.test(abs)) continue;
          if (seen.has(abs)) continue;
          seen.add(abs);
          out.push(abs);
        } catch {
          // ignore
        }
      }
      return out;
    }, selector);
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

async function crawlSinglePageMode(page, sourceUrl, selectors, maxPages) {
  await gotoPage(page, sourceUrl);
  const out = await crawlCommentsInOpenedPage(page, selectors, maxPages);
  const comments = normalizeCommentRows(out.rawRows);
  return {
    pagesScanned: out.pagesScanned,
    comments,
    rawCount: out.rawRows.length,
    notes: `single_page pages=${out.pagesScanned} raw=${out.rawRows.length} unique=${comments.length}`,
  };
}

async function crawlListToPostsMode(page, sourceUrl, selectors, maxPages, maxPosts, maxCommentPagesPerPost) {
  await gotoPage(page, sourceUrl);

  let pagesScanned = 0;
  const postUrlSet = new Set();

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    await expandAndScroll(page);
    const links = await extractPostLinks(page, selectors.postLink);
    for (const link of links) {
      if (postUrlSet.size >= maxPosts) break;
      postUrlSet.add(link);
    }
    pagesScanned += 1;

    if (postUrlSet.size >= maxPosts) break;
    if (pageNo >= maxPages) break;

    const moved = await clickNext(page, selectors.listNext || selectors.next);
    if (!moved) break;
  }

  const posts = Array.from(postUrlSet).slice(0, maxPosts);
  const allRawRows = [];
  for (const postUrl of posts) {
    const postPage = await page.context().newPage();
    try {
      await gotoPage(postPage, postUrl);
      const postOut = await crawlCommentsInOpenedPage(postPage, selectors, maxCommentPagesPerPost);
      pagesScanned += postOut.pagesScanned;
      allRawRows.push(...postOut.rawRows);
    } catch {
      // continue
    }
    await postPage.close();
  }

  const comments = normalizeCommentRows(allRawRows);
  return {
    pagesScanned,
    comments,
    rawCount: allRawRows.length,
    notes: `list_to_posts list_pages<=${maxPages} posts=${posts.length} raw=${allRawRows.length} unique=${comments.length}`,
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "external-crawler-service" });
});

app.post("/crawl", async (req, res) => {
  if (TOKEN) {
    const incoming = normalizeText(req.header("x-crawler-token") || "");
    if (!incoming || incoming !== TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized crawler token." });
    }
  }

  const sourceUrl = normalizeText(req.body?.sourceUrl || "");
  if (!sourceUrl || !isHttpUrl(sourceUrl)) {
    return res.status(400).json({ ok: false, error: "sourceUrl must be a valid http(s) URL." });
  }

  const collectionMode = req.body?.collectionMode === "list_to_posts" ? "list_to_posts" : "single_page";
  const maxPages = toInt(req.body?.maxPages, 8, 1, 100);
  const maxPosts = toInt(req.body?.maxPosts, 40, 1, 400);
  const maxCommentPagesPerPost = toInt(req.body?.maxCommentPagesPerPost, 3, 1, 30);
  const selectors = mergeSelectors(req.body?.selectors);

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 2400 },
      javaScriptEnabled: true,
    });

    page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const result =
      collectionMode === "list_to_posts"
        ? await crawlListToPostsMode(page, sourceUrl, selectors, maxPages, maxPosts, maxCommentPagesPerPost)
        : await crawlSinglePageMode(page, sourceUrl, selectors, maxPages);

    return res.json({
      ok: true,
      pagesScanned: result.pagesScanned,
      comments: result.comments,
      rawCount: result.rawCount,
      notes: result.notes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown crawler error";
    return res.status(500).json({ ok: false, error: message });
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // ignore
    }
    try {
      if (context) await context.close();
    } catch {
      // ignore
    }
    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`external crawler service listening on ${PORT}`);
});
