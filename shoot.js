// shoot.js
// Chromium-only screenshot runner with:
//
// ✅ Mode presets: --mode=1 (fast) / --mode=2 (slow)
// ✅ Sitemap batching: give a domain OR --sitemap, it will crawl /sitemap.xml and run all URLs
// ✅ Adaptive stabilisation: quick stability check, fallback to sweep (no spot images saved)
// ✅ Saves ONLY full-page screenshots: mobile.png + desktop.png per page
// ✅ Noise blocking (analytics + IG mp4) to speed up / reduce churn
// ✅ Folder structure:
//    runs/<domain>/<runTimestamp>/<pageName>/mobile.png
//    runs/<domain>/<runTimestamp>/<pageName>/desktop.png
//    runs/<domain>/<runTimestamp>/logs/<pageName>__<viewport>__*.{txt,json}
//
// Requirements: Node 18+ (global fetch) + Playwright installed
//
// Usage:
//   node shoot.js --urls="https://domain.com" --mode=1              # auto uses https://domain.com/sitemap.xml
//   node shoot.js --sitemap="https://domain.com/sitemap.xml" --mode=2
//   node shoot.js --urls="https://a.com/page,https://b.co.uk/contact" --mode=1
//
// Filters/caps (sitemap mode):
//   --include="/products/"   (substring filter)
//   --exclude="/account"     (substring filter)
//   --limit=50               (cap URLs)
//   --same-host-only         (keep only same hostname as sitemap domain)
//
// Optional overrides:
//   --wait-for-selector=".hero" --wait-timeout=20000
//   --no-block-noise          (disable request blocking)

const { chromium } = require("playwright");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const pagesByDomain = new Map();

const args = process.argv.slice(2);
const pdfEnabled = hasFlag("pdf");
const pdfOnly = hasFlag("pdf-only");
const pdfNameArg = getArg("pdf-name") || "review-pack.pdf";
const runDirArg = getArg("run-dir");

/* -------------------------
   ARG HELPERS
-------------------------- */
function getArg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
}
function hasFlag(flag) {
  return args.includes(`--${flag}`);
}

/* -------------------------
   REQUIRED: URLS (or sitemap)
-------------------------- */
const urlsArgRaw = getArg("urls");
const sitemapArgRaw = getArg("sitemap");

/* -------------------------
   BASIC HELPERS
-------------------------- */
function safeName(str) {
  return str
    .replace(/[^\w]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown-domain";
  }
}

function looksLikeDomainOnly(u) {
  return /^https?:\/\/[^/]+\/?$/.test(u);
}

function getPageName(url) {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/\/$/, "");
    if (!p) return "home";
    return p
      .replace(/^\//, "")
      .replace(/[^\w]+/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase();
  } catch {
    return "page";
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* -------------------------
   MODE PRESETS
-------------------------- */
const mode = Number(getArg("mode") || 0);

const MODE_PRESETS = {
  // Fast as possible while still forcing lazy content via sweep fallback
  1: {
    fastStabilizeMs: 4000,
    sweep: true,
    sweepSteps: 6,
    sweepWaitMs: 250,
    maxPendingImages: 5,
    stableIterations: 6,
    waitTimeoutMs: 20000,
  },
  // Slightly slower / deeper (more time for stabilise + longer sweep)
  2: {
    fastStabilizeMs: 5000,
    sweep: true,
    sweepSteps: 8,
    sweepWaitMs: 300,
    maxPendingImages: 5,
    stableIterations: 6,
    waitTimeoutMs: 25000,
  },
};

const preset = MODE_PRESETS[mode] || MODE_PRESETS[1];

/* -------------------------
   ARG PARSING (preset defaults, explicit args override)
-------------------------- */
const waitForSelector = (getArg("wait-for-selector") || "").replace(/^"|"$/g, "");
const waitTimeoutMs = Number(getArg("wait-timeout")) || preset.waitTimeoutMs;

const fastStabilizeMs = Number(getArg("fast-stabilize")) || preset.fastStabilizeMs;
const stableIterations = Number(getArg("stable-iterations")) || preset.stableIterations;

const maxPendingImages = Number(getArg("max-pending-images")) || preset.maxPendingImages;

const sweepEnabled = hasFlag("sweep") || preset.sweep || false;
const sweepSteps = Number(getArg("sweep-steps")) || preset.sweepSteps;
const sweepWaitMs = Number(getArg("sweep-wait")) || preset.sweepWaitMs;

const blockNoise = !hasFlag("no-block-noise"); // default ON

// Sitemap filters/caps
const include = getArg("include"); // substring filter
const exclude = getArg("exclude"); // substring filter
const limit = Number(getArg("limit") || 0); // 0 = no limit
const sameHostOnly = hasFlag("same-host-only");

/* -------------------------
   VIEWPORTS (full-page screenshots only)
-------------------------- */
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

/* -------------------------
   PAGE INTERACTION HELPERS
-------------------------- */
async function tryDismissCookieBanners(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Continue")',
    '[aria-label*="accept" i]',
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ timeout: 800 }).catch(() => {});
        await page.waitForTimeout(400);
        break;
      }
    } catch {}
  }
}

async function waitForFonts(page, timeoutMs = 8000) {
  try {
    await page.evaluate(async (t) => {
      if (!document.fonts) return;
      await Promise.race([document.fonts.ready, new Promise((res) => setTimeout(res, t))]);
    }, timeoutMs);
  } catch {}
}

async function waitForSelectorIfNeeded(page, selector, timeoutMs) {
  if (!selector) return false;
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs, state: "attached" });
    try {
      await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 5000), state: "visible" });
    } catch {}
    return true;
  } catch {
    return false;
  }
}

// Catch-all stability gate (best effort, may timeout on "never stable" pages)
async function waitForStability(
  page,
  { timeoutMs = 4000, pollMs = 250, stableIterations = 6, maxPendingImages = 5 } = {}
) {
  const start = Date.now();
  let stableCount = 0;
  let last = { height: 0, pendingImgs: 999, domSize: 0 };

  while (Date.now() - start < timeoutMs) {
    const cur = await page.evaluate(() => {
      const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      const imgs = Array.from(document.images || []);
      const pendingImgs = imgs.filter((img) => !img.complete).length;
      const domSize = document.getElementsByTagName("*").length;
      return { height, pendingImgs, domSize };
    });

    const heightStable = Math.abs(cur.height - last.height) <= 2;
    const domStable = Math.abs(cur.domSize - last.domSize) <= 5;
    const imgsOk = cur.pendingImgs <= maxPendingImages;

    if (heightStable && domStable && imgsOk) {
      stableCount += 1;
      if (stableCount >= stableIterations) return { ok: true, ...cur };
    } else {
      stableCount = 0;
    }

    last = cur;
    await page.waitForTimeout(pollMs);
  }

  return { ok: false, reason: "timeout" };
}

// Scroll sweep to force IO/lazy content render (no spot screenshots saved)
async function renderSweep(page, steps = 6, waitMs = 250) {
  const total = await page.evaluate(() => {
    const h1 = document.body?.scrollHeight || 0;
    const h2 = document.documentElement?.scrollHeight || 0;
    return Math.max(h1, h2);
  });

  for (let i = 0; i <= steps; i++) {
    const y = Math.floor((total * i) / steps);
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(waitMs);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
}

/* -------------------------
   SITEMAP SUPPORT
-------------------------- */
async function fetchText(url) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch not available. Use Node 18+.");
  }
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "ou-screenshot/1.0 (playwright)",
      accept: "application/xml,text/xml,text/plain,*/*",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

function parseSitemapLocs(xml) {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
  return Array.from(new Set(locs));
}

function isSitemapIndex(xml) {
  return /<sitemapindex\b/i.test(xml);
}

async function expandSitemap(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  let locs = parseSitemapLocs(xml);

  if (isSitemapIndex(xml)) {
    const childSitemaps = locs.filter((u) => u.endsWith(".xml"));
    const expanded = [];
    for (const sm of childSitemaps) {
      try {
        const childXml = await fetchText(sm);
        expanded.push(...parseSitemapLocs(childXml));
      } catch {}
    }
    locs = Array.from(new Set(expanded)).filter((u) => !u.endsWith(".xml"));
  } else {
    locs = locs.filter((u) => !u.endsWith(".xml"));
  }

  return locs;
}

function applyUrlFilters(urls, { include, exclude, limit, sameHostOnly, baseHost } = {}) {
  let out = urls.slice();

  if (sameHostOnly && baseHost) {
    out = out.filter((u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "") === baseHost.replace(/^www\./, "");
      } catch {
        return false;
      }
    });
  }

  if (include) out = out.filter((u) => u.includes(include));
  if (exclude) out = out.filter((u) => !u.includes(exclude));
  if (limit > 0) out = out.slice(0, limit);

  return out;
}

async function resolveUrlsFromArgs() {
  // Case 1: explicit sitemap provided
  if (sitemapArgRaw) {
    const sitemapUrl = sitemapArgRaw.includes("sitemap.xml")
      ? sitemapArgRaw
      : `${sitemapArgRaw.replace(/\/$/, "")}/sitemap.xml`;

    const baseHost = (() => {
      try {
        return new URL(sitemapUrl).hostname.replace(/^www\./, "");
      } catch {
        return null;
      }
    })();

    console.log(`Fetching sitemap: ${sitemapUrl}`);
    const found = await expandSitemap(sitemapUrl);
    const filtered = applyUrlFilters(found, { include, exclude, limit, sameHostOnly, baseHost });
    console.log(`Sitemap URLs queued: ${filtered.length}`);
    return filtered;
  }

  // Case 2: --urls provided
  let urls = urlsArgRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If single domain root URL, treat as sitemap mode automatically
  if (urls.length === 1 && looksLikeDomainOnly(urls[0])) {
    const root = urls[0].replace(/\/$/, "");
    const sitemapUrl = `${root}/sitemap.xml`;

    const baseHost = (() => {
      try {
        return new URL(root).hostname.replace(/^www\./, "");
      } catch {
        return null;
      }
    })();

    console.log(`Fetching sitemap: ${sitemapUrl}`);
    const found = await expandSitemap(sitemapUrl);
    const filtered = applyUrlFilters(found, { include, exclude, limit, sameHostOnly, baseHost });
    console.log(`Sitemap URLs queued: ${filtered.length}`);
    return filtered;
  }

  // Otherwise, treat as explicit list
  return urls;
}

/* -------------------------
   PDF REVIEW PACK
-------------------------- */
const PDF_PAGE = { width: 595.28, height: 841.89, margin: 36 };
const PDF_MAX_IMAGE_WIDTH_PX = 1200;
const PDF_TITLE_SIZE = 16;
const PDF_LABEL_SIZE = 12;
const PDF_TEXT_SIZE = 10;
const PDF_LINE_HEIGHT = 12;

function newPdfPage(pdfDoc) {
  return pdfDoc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
}

function wrapText(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, size);
    if (testWidth <= maxWidth) {
      line = testLine;
      continue;
    }

    if (line) lines.push(line);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
    } else {
      let chunk = "";
      for (const ch of word) {
        const chunkTest = chunk + ch;
        if (font.widthOfTextAtSize(chunkTest, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = chunkTest;
        }
      }
      line = chunk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrappedText(pdfDoc, page, lines, { x, y, maxWidth, font, size, lineHeight }) {
  let curPage = page;
  let curY = y;

  for (const line of lines) {
    const wrapped = wrapText(line, font, size, maxWidth);
    for (const wrappedLine of wrapped) {
      if (curY - lineHeight < PDF_PAGE.margin) {
        curPage = newPdfPage(pdfDoc);
        curY = PDF_PAGE.height - PDF_PAGE.margin;
      }
      curY -= lineHeight;
      curPage.drawText(wrappedLine, { x, y: curY, size, font, color: rgb(0, 0, 0) });
    }
  }

  return { page: curPage, y: curY };
}

function readLines(filePath, maxLines) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).slice(0, maxLines);
  return lines;
}

function summarizeStability(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const st = data.stability || data;
    const status = st && st.ok ? "ok" : "timeout";
    const extras = [];
    if (typeof st?.pendingImgs === "number") extras.push(`pendingImgs=${st.pendingImgs}`);
    if (typeof st?.domSize === "number") extras.push(`domSize=${st.domSize}`);
    return extras.length ? `${status} (${extras.join(", ")})` : status;
  } catch {
    return "invalid stability json";
  }
}

function buildLogsLines(pageName, logsDir) {
  const lines = [];
  let hasAny = false;
  const viewports = ["desktop", "mobile"];
  const logTypes = [
    { label: "Console errors", suffix: "__console-errors.txt" },
    { label: "Request failures", suffix: "__request-failures.txt" },
  ];

  for (const type of logTypes) {
    for (const vp of viewports) {
      const filePath = path.join(logsDir, `${pageName}__${vp}${type.suffix}`);
      const contentLines = readLines(filePath, 20);
      if (contentLines) {
        hasAny = true;
        lines.push(`${type.label} (${vp}):`);
        lines.push(...(contentLines.length ? contentLines : ["(none)"]));
      }
    }
  }

  for (const vp of viewports) {
    const filePath = path.join(logsDir, `${pageName}__${vp}__stability.json`);
    const summary = summarizeStability(filePath);
    if (summary) {
      hasAny = true;
      lines.push(`Stability (${vp}): ${summary}`);
    }
  }

  return { lines, hasAny };
}

function resolveImagePath(runDir, relPath, pageName, fileName) {
  if (relPath) return path.isAbsolute(relPath) ? relPath : path.join(runDir, relPath);
  if (pageName && fileName) return path.join(runDir, pageName, fileName);
  return null;
}

function drawSectionLabel(pdfDoc, page, y, label, font) {
  const x = PDF_PAGE.margin;
  const lineHeight = PDF_LABEL_SIZE + 4;
  let curPage = page;
  let curY = y;

  if (curY - lineHeight < PDF_PAGE.margin) {
    curPage = newPdfPage(pdfDoc);
    curY = PDF_PAGE.height - PDF_PAGE.margin;
  }

  curY -= lineHeight;
  curPage.drawText(label, { x, y: curY, size: PDF_LABEL_SIZE, font, color: rgb(0, 0, 0) });
  curY -= 6;
  return { page: curPage, y: curY };
}

async function addTiledImage(pdfDoc, page, y, imagePath) {
  const contentWidth = PDF_PAGE.width - PDF_PAGE.margin * 2;
  const x = PDF_PAGE.margin;

  if (!imagePath || !fs.existsSync(imagePath)) {
    return { page, y, missing: true };
  }

  let resizedBuffer;
  try {
    resizedBuffer = await sharp(imagePath)
      .resize({ width: PDF_MAX_IMAGE_WIDTH_PX, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return { page, y, missing: true };
  }

  const meta = await sharp(resizedBuffer).metadata();
  const imgWidthPx = meta.width || 1;
  const imgHeightPx = meta.height || 1;
  const scale = contentWidth / imgWidthPx;

  let remainingHeightPx = imgHeightPx;
  let offsetYpx = 0;
  let curPage = page;
  let curY = y;
  let isFirstSlice = true;

  while (remainingHeightPx > 0) {
    if (!isFirstSlice) {
      curPage = newPdfPage(pdfDoc);
      curY = PDF_PAGE.height - PDF_PAGE.margin;
    }

    let availableHeightPts = curY - PDF_PAGE.margin;
    if (availableHeightPts < 40) {
      curPage = newPdfPage(pdfDoc);
      curY = PDF_PAGE.height - PDF_PAGE.margin;
      availableHeightPts = curY - PDF_PAGE.margin;
    }

    const sliceHeightPx = Math.min(remainingHeightPx, Math.floor(availableHeightPts / scale));
    if (sliceHeightPx <= 0) break;

    const sliceBuffer = await sharp(resizedBuffer)
      .extract({ left: 0, top: offsetYpx, width: imgWidthPx, height: sliceHeightPx })
      .png()
      .toBuffer();

    const embedded = await pdfDoc.embedPng(sliceBuffer);
    const sliceHeightPts = sliceHeightPx * scale;

    curPage.drawImage(embedded, {
      x,
      y: curY - sliceHeightPts,
      width: contentWidth,
      height: sliceHeightPts,
    });

    curY = curY - sliceHeightPts - 10;
    remainingHeightPx -= sliceHeightPx;
    offsetYpx += sliceHeightPx;
    isFirstSlice = false;
  }

  return { page: curPage, y: curY, missing: false };
}

async function addPageSection(pdfDoc, fonts, runDir, pageInfo) {
  const { font, fontBold } = fonts;
  const logsDir = path.join(runDir, "logs");
  let page = newPdfPage(pdfDoc);
  let y = PDF_PAGE.height - PDF_PAGE.margin;
  const x = PDF_PAGE.margin;
  const maxWidth = PDF_PAGE.width - PDF_PAGE.margin * 2;

  const title = pageInfo.name || "page";
  page.drawText(title, { x, y: y - PDF_TITLE_SIZE, size: PDF_TITLE_SIZE, font: fontBold, color: rgb(0, 0, 0) });
  y -= PDF_TITLE_SIZE + 8;

  const urlText = pageInfo.url || "(url unavailable)";
  ({ page, y } = drawWrappedText(pdfDoc, page, [urlText], {
    x,
    y,
    maxWidth,
    font,
    size: PDF_TEXT_SIZE,
    lineHeight: PDF_LINE_HEIGHT,
  }));
  y -= 6;

  ({ page, y } = drawSectionLabel(pdfDoc, page, y, "Desktop", fontBold));
  const desktopPath = resolveImagePath(runDir, pageInfo.desktop, pageInfo.name, "desktop.png");
  const desktopResult = await addTiledImage(pdfDoc, page, y, desktopPath);
  page = desktopResult.page;
  y = desktopResult.y;
  if (desktopResult.missing) {
    ({ page, y } = drawWrappedText(pdfDoc, page, ["Missing desktop.png"], {
      x,
      y,
      maxWidth,
      font,
      size: PDF_TEXT_SIZE,
      lineHeight: PDF_LINE_HEIGHT,
    }));
    y -= 6;
  }

  ({ page, y } = drawSectionLabel(pdfDoc, page, y, "Mobile", fontBold));
  const mobilePath = resolveImagePath(runDir, pageInfo.mobile, pageInfo.name, "mobile.png");
  const mobileResult = await addTiledImage(pdfDoc, page, y, mobilePath);
  page = mobileResult.page;
  y = mobileResult.y;
  if (mobileResult.missing) {
    ({ page, y } = drawWrappedText(pdfDoc, page, ["Missing mobile.png"], {
      x,
      y,
      maxWidth,
      font,
      size: PDF_TEXT_SIZE,
      lineHeight: PDF_LINE_HEIGHT,
    }));
    y -= 6;
  }

  const logs = buildLogsLines(pageInfo.name, logsDir);
  if (logs.hasAny) {
    if (y - 80 < PDF_PAGE.margin) {
      page = newPdfPage(pdfDoc);
      y = PDF_PAGE.height - PDF_PAGE.margin;
    }
    ({ page, y } = drawSectionLabel(pdfDoc, page, y, "Logs", fontBold));
    ({ page, y } = drawWrappedText(pdfDoc, page, logs.lines, {
      x,
      y,
      maxWidth,
      font,
      size: PDF_TEXT_SIZE,
      lineHeight: PDF_LINE_HEIGHT,
    }));
  }
}

function getDomainData(domain, runTs) {
  if (pagesByDomain.has(domain)) return pagesByDomain.get(domain);
  const runDir = path.join(process.cwd(), "runs", domain, runTs);
  const entry = { runDir, pages: [] };
  pagesByDomain.set(domain, entry);
  return entry;
}

async function buildPdfFromRunDir(runDir, { pdfName = "review-pack.pdf", pagesOverride = null } = {}) {
  const absRunDir = path.isAbsolute(runDir) ? runDir : path.join(process.cwd(), runDir);
  const manifestPath = path.join(absRunDir, "manifest.json");
  let pages = pagesOverride;

  if (!pages && fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(manifest.pages)) {
        pages = manifest.pages;
      }
    } catch {}
  }

  if (!pages) {
    const entries = fs.readdirSync(absRunDir, { withFileTypes: true });
    pages = entries
      .filter((e) => e.isDirectory() && e.name !== "logs")
      .map((e) => ({
        name: e.name,
        url: null,
        desktop: `${e.name}/desktop.png`,
        mobile: `${e.name}/mobile.png`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const pageInfo of pages) {
    await addPageSection(pdfDoc, { font, fontBold }, absRunDir, pageInfo);
  }

  const pdfBytes = await pdfDoc.save();
  const outPath = path.join(absRunDir, pdfName || "review-pack.pdf");
  fs.writeFileSync(outPath, pdfBytes);
  console.log(`✔ PDF review pack saved → ${outPath}`);
}

/* -------------------------
   MAIN
-------------------------- */
(async () => {
  if (pdfOnly) {
    if (!runDirArg) {
      console.log('Usage: node shoot.js --pdf-only --run-dir="runs/domain/2026-01-01T22-05-56-316Z"');
      process.exit(1);
    }
    await buildPdfFromRunDir(runDirArg, { pdfName: pdfNameArg });
    return;
  }

  if (!urlsArgRaw && !sitemapArgRaw) {
    console.log('Usage: node shoot.js --urls="https://domain.com" --mode=1|2');
    console.log('   or: node shoot.js --sitemap="https://domain.com/sitemap.xml" --mode=1|2');
    process.exit(1);
  }

  const runTs = new Date().toISOString().replace(/[:.]/g, "-");
  const urls = await resolveUrlsFromArgs();

  if (!urls.length) {
    console.log("No URLs to run (empty after filtering).");
    process.exit(0);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Block known noisy requests (speed + reduces "never stable" pages)
  if (blockNoise) {
    await context.route("**/*", (route) => {
      const u = route.request().url();

      // Analytics noise
      if (
        u.includes("a.klaviyo.com/onsite/track-analytics") ||
        u.includes("monorail-edge.shopifysvc.com") ||
        u.includes("/api/collect")
      ) {
        return route.abort();
      }

      // Block Instagram videos (keep images)
      if (u.includes("scontent.cdninstagram.com") && u.toLowerCase().includes(".mp4")) {
        return route.abort();
      }

      return route.continue();
    });
  }

  for (const url of urls) {
    const domain = getDomain(url);
    const pageName = getPageName(url);

    const domainData = getDomainData(domain, runTs);
    const runDir = domainData.runDir;
    const pageDir = path.join(runDir, pageName);
    const logsDir = path.join(runDir, "logs");

    fs.mkdirSync(pageDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    for (const vp of viewports) {
      const page = await context.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const consoleErrors = [];
      const requestFailures = [];

      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      page.on("requestfailed", (req) => {
        requestFailures.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText || "failed"}`);
      });

      const logBase = `${pageName}__${vp.name}`;

      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      } catch (e) {
        consoleErrors.push(`NAV_FAIL: ${String(e)}`);
      }

      await tryDismissCookieBanners(page);

      // Optional: if you know a page must contain something, wait for it
      await waitForSelectorIfNeeded(page, waitForSelector, waitTimeoutMs);

      await waitForFonts(page);

      // Adaptive: quick stability, else sweep and proceed (no long waits)
      let stability = await waitForStability(page, {
        timeoutMs: fastStabilizeMs,
        stableIterations: Math.max(3, Math.floor(stableIterations / 2)),
        maxPendingImages,
      });

      if (!stability.ok) {
        if (sweepEnabled) await renderSweep(page, sweepSteps, sweepWaitMs);

        // small settle after sweep (best effort)
        stability = await waitForStability(page, {
          timeoutMs: 2500,
          stableIterations: 3,
          maxPendingImages,
        });
      }

      // Save final full-page screenshot only
      await page.screenshot({
        path: path.join(pageDir, `${vp.name}.png`),
        fullPage: true,
      });

      // Write logs to /logs subfolder
      if (consoleErrors.length) {
        fs.writeFileSync(path.join(logsDir, `${logBase}__console-errors.txt`), consoleErrors.join("\n"), "utf8");
      }

      if (requestFailures.length) {
        fs.writeFileSync(path.join(logsDir, `${logBase}__request-failures.txt`), requestFailures.join("\n"), "utf8");
      }

      fs.writeFileSync(
        path.join(logsDir, `${logBase}__stability.json`),
        JSON.stringify(
          {
            url,
            domain,
            pageName,
            viewport: vp,
            mode: mode || null,
            runTs,
            options: {
              waitForSelector: waitForSelector || null,
              waitTimeoutMs,
              fastStabilizeMs,
              stableIterations,
              maxPendingImages,
              sweepEnabled,
              sweepSteps,
              sweepWaitMs,
              blockNoise,
              sitemap: sitemapArgRaw || null,
              include: include || null,
              exclude: exclude || null,
              limit: limit || 0,
              sameHostOnly,
            },
            stability,
            ts: new Date().toISOString(), 
          },
          null,
          2
        ),
        "utf8"
      );

      await page.close();
    }

    domainData.pages.push({
      name: pageName,
      url,
      desktop: `${pageName}/desktop.png`,
      mobile: `${pageName}/mobile.png`,
    });

    fs.writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ domain, runTs: runTs, pages: domainData.pages }, null, 2),
      "utf8"
    );


    console.log(`✔ Captured ${url} → runs/${domain}/${runTs}/${pageName}/`);
  }

  await browser.close();

  if (pdfEnabled) {
    for (const entry of pagesByDomain.values()) {
      await buildPdfFromRunDir(entry.runDir, { pdfName: pdfNameArg, pagesOverride: entry.pages });
    }
  }
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
