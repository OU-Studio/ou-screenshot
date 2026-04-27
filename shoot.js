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
const passArg = getArg("pass");

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
        await btn.click({ timeout: 800 }).catch(() => { });
        await page.waitForTimeout(400);
        break;
      }
    } catch { }
  }
}

async function waitForFonts(page, timeoutMs = 8000) {
  try {
    await page.evaluate(async (t) => {
      if (!document.fonts) return;
      await Promise.race([document.fonts.ready, new Promise((res) => setTimeout(res, t))]);
    }, timeoutMs);
  } catch { }
}

async function waitForSelectorIfNeeded(page, selector, timeoutMs) {
  if (!selector) return false;
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs, state: "attached" });
    try {
      await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 5000), state: "visible" });
    } catch { }
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
// Scroll sweep to force IO/lazy content render (no spot screenshots saved)
// - Recomputes scrollHeight as the page expands
// - Runs revealAll + RAF settle at each step
async function renderSweep(page, steps = 8, waitMs = 350) {
  // Try to keep steps relative even if scrollHeight grows while scrolling
  for (let i = 0; i <= steps; i++) {
    const total = await page.evaluate(() => {
      const h1 = document.body?.scrollHeight || 0;
      const h2 = document.documentElement?.scrollHeight || 0;
      return Math.max(h1, h2);
    });

    const y = Math.floor((total * i) / steps);

    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(waitMs);

    // Force visibility each step (helps Squarespace blocks stuck in preFade states)
    try {
      await revealAll(page);
      await rafSettle(page, 4);
    } catch {}
  }

  // Return to top and let layout settle
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  try {
    await revealAll(page);
    await rafSettle(page, 4);
  } catch {}
}

async function tryPasswordGate(page, password) {
  if (!password) return { attempted: false, reason: "no-pass" };

  try {
    const input = await page.$('input[name="password"]');
    if (!input) return { attempted: false, reason: "no-field" };

    await input.fill(password);

    const form = await page.$('input[name="password"] >> xpath=ancestor::form[1]');
    if (form) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
        form.evaluate((f) => f.submit()),
      ]);
    } else {
      const submit =
        (await page.$('button[type="submit"], input[type="submit"]')) ||
        (await page.$('button:has-text("Submit"), button:has-text("Enter"), button:has-text("Continue")'));
      if (submit) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
          submit.click(),
        ]);
      } else {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
          page.keyboard.press("Enter"),
        ]);
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    return { attempted: true, reason: "submitted" };
  } catch (e) {
    return { attempted: true, reason: `error:${String(e)}` };
  }
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
      } catch { }
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
  if (pageName && fileName) return path.join(runDir, fileName, `${pageName}.png`);
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
    } catch { }
  }

  if (!pages) {
    const desktopDir = path.join(absRunDir, "desktop");
    const mobileDir = path.join(absRunDir, "mobile");
    const desktopFiles = fs.existsSync(desktopDir)
      ? fs.readdirSync(desktopDir).filter((f) => f.endsWith(".png"))
      : [];
    const mobileFiles = fs.existsSync(mobileDir)
      ? fs.readdirSync(mobileDir).filter((f) => f.endsWith(".png"))
      : [];
    const names = Array.from(
      new Set(
        [...desktopFiles, ...mobileFiles].map((f) => f.replace(/\.png$/i, ""))
      )
    ).sort((a, b) => a.localeCompare(b));

    pages = names.map((name) => ({
      name,
      url: null,
      desktop: `desktop/${name}.png`,
      mobile: `mobile/${name}.png`,
    }));
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
  const context = await browser.newContext({
    reducedMotion: "reduce",
  });

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
    const desktopDir = path.join(runDir, "desktop");
    const mobileDir = path.join(runDir, "mobile");
    const logsDir = path.join(runDir, "logs");

    fs.mkdirSync(desktopDir, { recursive: true });
    fs.mkdirSync(mobileDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    for (const vp of viewports) {
      const page = await context.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const stepPrefix = `[${pageName} ${vp.name}]`;

      const consoleErrors = [];
      const requestFailures = [];

      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      page.on("requestfailed", (req) => {
        requestFailures.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText || "failed"}`);
      });

      const logBase = `${pageName}__${vp.name}`;

      console.log(`${stepPrefix} goto:start ${url}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        console.log(`${stepPrefix} goto:done`);
      } catch (e) {
        consoleErrors.push(`NAV_FAIL: ${String(e)}`);
        console.log(`${stepPrefix} goto:error ${String(e)}`);
      }

      const passResult = await tryPasswordGate(page, passArg);
      console.log(`${stepPrefix} passGate ${JSON.stringify(passResult)}`);

      console.log(`${stepPrefix} strike:before:start`);
      let strikeBefore = { strikeCount: -1, totalRoots: 0, error: null };
      try {
        strikeBefore = await countStrikeThroughButtons(page);
      } catch (e) {
        strikeBefore = { strikeCount: -1, totalRoots: 0, error: String(e) };
      }
      console.log(`${stepPrefix} strike:before ${strikeBefore.strikeCount}/${strikeBefore.totalRoots}`);

      await tryDismissCookieBanners(page);
      console.log(`${stepPrefix} cookies:done`);

      // Optional: if you know a page must contain something, wait for it
      if (waitForSelector) console.log(`${stepPrefix} waitForSelector:start ${waitForSelector}`);
      await waitForSelectorIfNeeded(page, waitForSelector, waitTimeoutMs);
      if (waitForSelector) console.log(`${stepPrefix} waitForSelector:done`);

      console.log(`${stepPrefix} fonts:wait`);
      await waitForFonts(page);
      console.log(`${stepPrefix} fonts:done`);

      // Adaptive: quick stability, else sweep and proceed (no long waits)
      console.log(`${stepPrefix} stability:fast`);
      let stability = await waitForStability(page, {
        timeoutMs: fastStabilizeMs,
        stableIterations: Math.max(3, Math.floor(stableIterations / 2)),
        maxPendingImages,
      });

      if (!stability.ok) {
        console.log(`${stepPrefix} stability:fast timeout; sweep=${sweepEnabled}`);
        if (sweepEnabled) await renderSweep(page, sweepSteps, sweepWaitMs);

        // small settle after sweep (best effort)
        console.log(`${stepPrefix} stability:post-sweep`);
        stability = await waitForStability(page, {
          timeoutMs: 2500,
          stableIterations: 3,
          maxPendingImages,
        });
      }


      async function rafSettle(page, frames = 3) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      await new Promise(requestAnimationFrame);
    }
  }, frames);
}

async function revealAll(page) {
  return await page.evaluate(() => {
    const root = document.querySelector('main') || document.querySelector('#page') || document.body;
    const els = Array.from(root.querySelectorAll('*'));
    let changed = 0;

    for (const el of els) {
      const tag = el.tagName;
      if (!tag || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|HEAD)$/.test(tag)) continue;

      const cs = getComputedStyle(el);

      // Only bother with nodes that occupy space (or fixed UI)
      const occupiesSpace = (el.offsetWidth > 0 || el.offsetHeight > 0) || cs.position === 'fixed';
      if (!occupiesSpace) continue;

      const opacity0 = parseFloat(cs.opacity || '1') === 0;
      const hidden = cs.visibility === 'hidden';
      const displayNone = cs.display === 'none';

      if (opacity0 || hidden || displayNone || cs.transform !== 'none' || cs.filter !== 'none') {
        el.style.opacity = '1';
        el.style.visibility = 'visible';
        if (displayNone) el.style.display = 'block';
        el.style.transform = 'none';
        el.style.filter = 'none';
        changed++;
      }
    }

    document.querySelectorAll('.preFade,.preSlide,.preScale,.is-hidden,.is-invisible').forEach(el => {
      el.classList.remove('preFade','preSlide','preScale','is-hidden','is-invisible');
      el.style.opacity = '1';
      el.style.visibility = 'visible';
      el.style.transform = 'none';
      el.style.filter = 'none';
    });

    document
  .querySelectorAll('#jp-carousel-loading-overlay, .jp-carousel-overlay, .offcanvas, .offscreen-overlay')
  .forEach(el => el.remove());


    // Count remaining “invisible” elements for debugging
    let stillHidden = 0;
    for (const el of els) {
      const cs = getComputedStyle(el);
      if ((el.offsetWidth > 0 || el.offsetHeight > 0) && (cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0)) {
        stillHidden++;
      }
    }

    return { changed, stillHidden };
  });
}

async function hiddenSnapshot(page, sampleSize = 25) {
  return await page.evaluate((n) => {
    const root = document.querySelector('main') || document.querySelector('#page') || document.body;
    const els = Array.from(root.querySelectorAll('*'));

    const hidden = [];
    let hiddenCount = 0;

    for (const el of els) {
      const tag = el.tagName;
      if (!tag || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|HEAD)$/.test(tag)) continue;

      const cs = getComputedStyle(el);
      const occupiesSpace = (el.offsetWidth > 0 || el.offsetHeight > 0) || cs.position === 'fixed';
      if (!occupiesSpace) continue;

      const isHidden =
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        parseFloat(cs.opacity || '1') === 0;

      if (isHidden) {
        hiddenCount++;
        if (hidden.length < n) {
          const rect = el.getBoundingClientRect();
          hidden.push({
            tag,
            id: el.id || null,
            class: el.className || null,
            dataAnimationRole: el.getAttribute('data-animation-role'),
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            transform: cs.transform,
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      }
    }

    return {
      hiddenCount,
      sample: hidden,
      preFadeCount: document.querySelectorAll('.preFade,.preSlide,.preScale,.is-hidden,.is-invisible').length,
    };
  }, sampleSize);
}

async function countStrikeThroughButtons(page) {
  return await page.evaluate(() => {
    const roots = [
      ".button",
      "a.sqs-button-element",
      ".sqs-block-button a",
      "button",
      "[role='button']",
      "span",
    ];
    const els = [];
    roots.forEach((sel) => document.querySelectorAll(sel).forEach((n) => els.push(n)));

    const hits = [];
    for (const el of els) {
      const all = [el, ...el.querySelectorAll("*")];
      for (const n of all) {
        const cs = getComputedStyle(n);
        const tdl = cs.textDecorationLine || cs.textDecoration || "";
        if (String(tdl).includes("line-through")) {
          hits.push({
            rootSelectorHit: el.matches(".button") ? ".button" : el.tagName.toLowerCase(),
            tag: n.tagName,
            className: n.className || "",
            text: (n.textContent || "").trim().slice(0, 120),
            textDecorationLine: cs.textDecorationLine || null,
            textDecoration: cs.textDecoration || null,
            color: cs.color,
            opacity: cs.opacity,
          });
          break; // one hit is enough per root
        }
      }
    }

    return { totalRoots: els.length, strikeCount: hits.length, sample: hits.slice(0, 25) };
  });
}

async function logStrikeThroughRuleOrigins(page, logsDir, logBase) {
  const handle = await page.evaluateHandle(() => {
    const candidates = document.querySelectorAll(
      ".button, a.sqs-button-element, .sqs-block-button a, button, [role='button'], span"
    );

    for (const root of candidates) {
      const all = [root, ...root.querySelectorAll("*")];
      for (const n of all) {
        const cs = getComputedStyle(n);
        const tdl = cs.textDecorationLine || cs.textDecoration || "";
        if (String(tdl).includes("line-through")) return n;
      }
    }
    return null;
  });

  const el = handle.asElement();
  if (!el) {
    fs.writeFileSync(
      path.join(logsDir, `${logBase}__strike-origins.json`),
      JSON.stringify({ found: false }, null, 2)
    );
    return;
  }

  const client = await page.target().createCDPSession();

  // Get nodeId for the element
  const { nodeId } = await client
    .send("DOM.describeNode", { objectId: el._remoteObject.objectId })
    .then((r) => ({ nodeId: r.node.nodeId }));

  const styles = await client.send("CSS.getMatchedStylesForNode", { nodeId });

  // Extract rules that set text-decoration / text-decoration-line
  const relevant = [];

  const scanDecls = (style, origin) => {
    if (!style?.cssProperties) return;
    for (const p of style.cssProperties) {
      if (!p?.name) continue;
      const name = p.name.toLowerCase();
      if (name === "text-decoration" || name === "text-decoration-line" || name === "text-decoration-thickness") {
        relevant.push({ origin, name: p.name, value: p.value });
      }
    }
  };

  scanDecls(styles.inlineStyle, "inlineStyle");
  scanDecls(styles.attributesStyle, "attributesStyle");

  for (const mr of styles.matchedCSSRules || []) {
    scanDecls(mr.rule?.style, `selector: ${mr.rule?.selectorList?.text || "(unknown)"}`);
  }

  for (const ir of styles.inherited || []) {
    // Inherited text-decoration can come from parent
    for (const mr of ir.matchedCSSRules || []) {
      scanDecls(mr.rule?.style, `inherited selector: ${mr.rule?.selectorList?.text || "(unknown)"}`);
    }
  }

  const computed = await page.evaluate((node) => {
    const cs = getComputedStyle(node);
    return {
      tag: node.tagName,
      className: node.className || "",
      text: (node.textContent || "").trim().slice(0, 160),
      textDecorationLine: cs.textDecorationLine || null,
      textDecoration: cs.textDecoration || null,
    };
  }, el);

  fs.writeFileSync(
    path.join(logsDir, `${logBase}__strike-origins.json`),
    JSON.stringify(
      { found: true, computed, relevant, matchedRuleCount: (styles.matchedCSSRules || []).length },
      null,
      2
    ),
    "utf8"
  );
}

async function logSubmitLineArtifacts(page, logsDir, logBase) {
  const data = await page.evaluate(() => {
    // Try common Squarespace submit selectors
    const btn =
      document.querySelector(".form-submit-button") ||
      document.querySelector(".sqs-block-form .form-wrapper input[type='submit']") ||
      document.querySelector(".sqs-block-form button[type='submit']") ||
      document.querySelector("button[type='submit'], input[type='submit']");

    const label = document.querySelector(".form-submit-button-label");

    const root = label || btn;
    if (!root) return { found: false };

    const rootRect = root.getBoundingClientRect();

    const px = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };

    const lineFromStyle = (cs) => {
      // Detect 1px-ish horizontal rules
      const bt = px(cs.borderTopWidth);
      const bb = px(cs.borderBottomWidth);
      const h = px(cs.height);

      const hasBorderLine = bt === 1 || bb === 1;
      const has1pxBox =
        h === 1 &&
        cs.backgroundColor &&
        cs.backgroundColor !== "rgba(0, 0, 0, 0)" &&
        cs.backgroundColor !== "transparent";

      return { hasBorderLine, has1pxBox, bt, bb, h };
    };

    const checkNode = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();

      // Skip things outside root box
      const intersects =
        r.left < rootRect.right &&
        r.right > rootRect.left &&
        r.top < rootRect.bottom &&
        r.bottom > rootRect.top;

      if (!intersects) return null;

      const base = lineFromStyle(cs);
      const hits = [];

      if (base.hasBorderLine || base.has1pxBox) {
        hits.push({
          kind: "element",
          tag: el.tagName,
          className: el.className || "",
          text: (el.textContent || "").trim().slice(0, 80),
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          borderTopWidth: cs.borderTopWidth,
          borderBottomWidth: cs.borderBottomWidth,
          backgroundColor: cs.backgroundColor,
          position: cs.position,
          zIndex: cs.zIndex,
        });
      }

      // Pseudo-elements
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (!ps || ps.content === "none") continue;

        const p = lineFromStyle(ps);
        if (!(p.hasBorderLine || p.has1pxBox)) continue;

        hits.push({
          kind: pseudo,
          tag: el.tagName,
          className: el.className || "",
          pseudoContent: ps.content,
          // we can't get pseudo rect directly; record positioning hints
          pseudo: {
            position: ps.position,
            top: ps.top,
            bottom: ps.bottom,
            left: ps.left,
            right: ps.right,
            height: ps.height,
            borderTopWidth: ps.borderTopWidth,
            borderBottomWidth: ps.borderBottomWidth,
            backgroundColor: ps.backgroundColor,
            opacity: ps.opacity,
            zIndex: ps.zIndex,
          },
          hostRect: { x: r.x, y: r.y, w: r.width, h: r.height },
        });
      }

      return hits.length ? hits : null;
    };

    const nodes = [root, ...root.querySelectorAll("*")];
    const findings = [];
    for (const n of nodes) {
      const res = checkNode(n);
      if (res) findings.push(...res);
    }

    return {
      found: true,
      rootUsed: root === label ? ".form-submit-button-label" : "submit-button",
      rootRect: { x: rootRect.x, y: rootRect.y, w: rootRect.width, h: rootRect.height },
      findingsCount: findings.length,
      findings: findings.slice(0, 80),
    };
  });

  fs.writeFileSync(
    path.join(logsDir, `${logBase}__submit-line-artifacts.json`),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}




      await page.addStyleTag({
        content: `
  /* Stop motion + transitions so we don't capture mid-fade */
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }

  /* Common Squarespace hidden/pre states */
  .preFade, .preSlide, .preScale, .is-hidden, .is-invisible, img {
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    filter: none !important;
  }
    /* screenshot clamp: hide decorative spans that can render as strike/lines */
    .form-submit-button-state > span:not(:first-of-type){
      display: none !important;
    }
  `
      });

      // Run a short settle loop: reveal -> repaint -> reveal
      console.log(`${stepPrefix} reveal:loop`);
      let last = null;
      for (let i = 0; i < 4; i++) {
        last = await revealAll(page);
        await rafSettle(page, 4);
        await page.waitForTimeout(120);
        if (last.stillHidden === 0) break;
      }

      console.log(`[reveal] ${vp.name} changed=${last.changed} stillHidden=${last.stillHidden}`);


      await page.waitForTimeout(250); // allow repaint

// 1) settle at top
await rafSettle(page, 4);

// 2) initial reveal
let reveal0 = await revealAll(page);
await rafSettle(page, 4);
await page.waitForTimeout(150);

// 3) sweep (this is the important part for Squarespace IO)
      if (sweepEnabled) {
        console.log(`${stepPrefix} reveal:sweep`);
        await renderSweep(page, sweepSteps, sweepWaitMs);
      }

// 4) final reveal + short settle
let reveal1 = await revealAll(page);
await rafSettle(page, 6);
await page.waitForTimeout(250);

// 5) debug snapshot
      const snap = await hiddenSnapshot(page, 30);

      // Write a debug json you can inspect per page+viewport
      fs.writeFileSync(
  path.join(logsDir, `${logBase}__reveal-debug.json`),
  JSON.stringify({ reveal0, reveal1, snap }, null, 2),
  "utf8"
);

      console.log(
        `[reveal] ${vp.name} changed0=${reveal0.changed} stillHidden0=${reveal0.stillHidden} | ` +
        `changed1=${reveal1.changed} stillHidden1=${reveal1.stillHidden} | hiddenNow=${snap.hiddenCount} preFadeNow=${snap.preFadeCount}`
      );

      const firstSectionProbe = await page.evaluate(async () => {
        const sectionsRoot = document.querySelector(".sections");
        const firstSection = sectionsRoot?.querySelector(".page-section");

        if (!sectionsRoot) return { ok: false, reason: "No .sections found" };
        if (!firstSection) return { ok: false, reason: "No .page-section found inside .sections" };

        // Scroll section into view to trigger IO/lazy loaders
        firstSection.scrollIntoView({ block: "start", behavior: "instant" });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        const imgs = Array.from(firstSection.querySelectorAll("img"));

        // Capture state BEFORE any forcing
        const before = imgs.map((img) => ({
          src: img.getAttribute("src"),
          currentSrc: img.currentSrc || null,
          dataSrc: img.getAttribute("data-src") || img.dataset?.src || null,
          dataImage: img.getAttribute("data-image") || img.dataset?.image || null,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }));

        // If src is missing/placeholder, promote data-src/data-image
        let promoted = 0;
        for (const img of imgs) {
          const curSrc = img.getAttribute("src") || "";
          const ds = img.getAttribute("data-src") || img.dataset?.src;
          const di = img.getAttribute("data-image") || img.dataset?.image;

          const isPlaceholder = !curSrc || curSrc === "about:blank" || curSrc.startsWith("data:");
          if (isPlaceholder && (ds || di)) {
            img.src = ds || di;
            promoted++;
          }

          // ensure eager
          try {
            img.loading = "eager";
          } catch {}
          img.setAttribute("loading", "eager");
        }

        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        // Best-effort decode
        await Promise.all(imgs.map((img) => (img.decode ? img.decode().catch(() => null) : null)));

        const after = imgs.map((img) => ({
          src: img.getAttribute("src"),
          currentSrc: img.currentSrc || null,
          dataSrc: img.getAttribute("data-src") || img.dataset?.src || null,
          dataImage: img.getAttribute("data-image") || img.dataset?.image || null,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }));

        return {
          ok: true,
          sectionTag: firstSection.tagName,
          sectionClasses: firstSection.className,
          imgCount: imgs.length,
          promoted,
          before,
          after,
        };
      });

      // Persist the probe log
      fs.writeFileSync(
        path.join(logsDir, `${logBase}__first-section-images.json`),
        JSON.stringify(firstSectionProbe, null, 2),
        "utf8"
      );

      console.log(`${stepPrefix} overlay:scan`);
      const overlayFix = await page.evaluate(() => {
        const fixes = [];

        const isTransparent = (bg) => {
          if (!bg) return true;
          // bg like "rgba(r,g,b,a)" or "rgb(r,g,b)" or "transparent"
          if (bg === "transparent") return true;
          const m = bg.match(/rgba?\(([^)]+)\)/i);
          if (!m) return false;
          const parts = m[1].split(",").map((s) => s.trim());
          const a = parts.length === 4 ? parseFloat(parts[3]) : 1;
          return !Number.isFinite(a) || a === 0;
        };

        document.querySelectorAll(".page-section.has-background").forEach((section) => {
          const bg = section.querySelector(".section-background");
          const img = bg?.querySelector("img");
          const overlay = bg?.querySelector(".section-background-overlay");
          if (!bg || !img || !overlay) return;

          // Only intervene if:
          // - the image is loaded (so overlay would visibly cover it)
          // - overlay is effectively opaque and has a non-transparent background
          const cs = getComputedStyle(overlay);
          const opacity = parseFloat(cs.opacity || "1");
          const bgc = cs.backgroundColor;

          const imgOk = img.complete && img.naturalWidth > 0;
          const overlayIsMasking = opacity >= 0.95 && !isTransparent(bgc);

          if (imgOk && overlayIsMasking) {
            fixes.push({
              sectionId: section.id || null,
              overlayOpacity: cs.opacity,
              overlayBg: bgc,
            });

            // Make overlay transparent for capture
            overlay.style.opacity = "0";
            overlay.style.backgroundColor = "transparent";
            overlay.style.pointerEvents = "none";
          }
        });

        return { fixedCount: fixes.length, fixes };
      });

      // optional: write log
      fs.writeFileSync(
        path.join(logsDir, `${logBase}__overlay-fix.json`),
        JSON.stringify(overlayFix, null, 2),
        "utf8"
      );

      // allow repaint
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.evaluate(() => new Promise(requestAnimationFrame));

      console.log(`${stepPrefix} strike:after:start`);
      let strikeAfter = { strikeCount: -1, totalRoots: 0, error: null };
      try {
        strikeAfter = await countStrikeThroughButtons(page);
      } catch (e) {
        strikeAfter = { strikeCount: -1, totalRoots: 0, error: String(e) };
      }
      console.log(`${stepPrefix} strike:after ${strikeAfter.strikeCount}/${strikeAfter.totalRoots}`);
      fs.writeFileSync(
        path.join(logsDir, `${logBase}__strike-count.json`),
        JSON.stringify({ strikeBefore, strikeAfter }, null, 2),
        "utf8"
      );

      console.log(`${stepPrefix} strike:origins`);
      await logStrikeThroughRuleOrigins(page, logsDir, logBase);

      console.log(`${stepPrefix} submit-line:scan`);
      await logSubmitLineArtifacts(page, logsDir, logBase);


      // Save final full-page screenshot only
      console.log(`${stepPrefix} screenshot:start`);
      await page.screenshot({
        path: path.join(vp.name === "desktop" ? desktopDir : mobileDir, `${pageName}.png`),
        fullPage: true,
      });
      console.log(`${stepPrefix} screenshot:done`);

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
      desktop: `desktop/${pageName}.png`,
      mobile: `mobile/${pageName}.png`,
    });

    fs.writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ domain, runTs: runTs, pages: domainData.pages }, null, 2),
      "utf8"
    );


    console.log(`✔ Captured ${url} → runs/${domain}/${runTs}/`);
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
