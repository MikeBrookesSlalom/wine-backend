import express from "express";
import puppeteer from "puppeteer";
import * as fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = "/tmp/price-cache.json";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch (e) { console.warn("cache load:", e.message); }
  return {};
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch (e) { console.warn("cache save:", e.message); }
}
function fresh(entry) { return entry && entry.at && Date.now() - new Date(entry.at).getTime() < CACHE_TTL; }

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process","--no-zygote"],
    });
  }
  return browserPromise;
}

function normaliseRetailer(name) {
  const n = name.toLowerCase();
  if (n.includes("tesco")) return "Tesco";
  if (n.includes("sainsbury")) return "Sainsbury's";
  if (n.includes("asda")) return "ASDA";
  if (n.includes("waitrose")) return "Waitrose";
  if (n.includes("m&s") || n.includes("marks") || n.includes("ocado")) return "M&S";
  return null;
}

// Words that mark a NON-standard variant we should avoid unless explicitly searched
const VARIANT_WORDS = ["limited edition","magnum","the beach","gift","half bottle","187ml","half","1.5l","3l","jeroboam","personalised","case of","x6","x 6","6 x","12 x"];

/* Score how well a product title matches the query.
   Higher = better. Returns -1 if it should be rejected. */
function matchScore(title, queryTerms, query) {
  const t = title.toLowerCase();
  // every query word must be present
  for (const w of queryTerms) { if (!t.includes(w)) return -1; }
  let score = 100;
  // penalise variant products unless the query asked for that word
  for (const vw of VARIANT_WORDS) {
    if (t.includes(vw) && !query.toLowerCase().includes(vw)) score -= 40;
  }
  // prefer shorter titles (closer to the plain product)
  score -= Math.min(30, Math.floor(t.length / 6));
  return score;
}

/* Pull retailer+price pairs from a product-page JSON payload.
   Only accepts a "current price" number; ignores per-litre & was-prices by key name. */
function harvestPrices(node, out, depth = 0) {
  if (depth > 9 || node == null) return;
  if (Array.isArray(node)) { for (const it of node) harvestPrices(it, out, depth + 1); return; }
  if (typeof node !== "object") return;

  const keys = Object.keys(node);
  let retailerName = null;
  let price = null;

  for (const k of keys) {
    const v = node[k];
    const kl = k.toLowerCase();
    if (typeof v === "string" && (kl.includes("retailer") || kl.includes("merchant") || kl.includes("store") || kl.includes("shop") || kl.includes("seller") || kl.includes("supermarket"))) {
      retailerName = v;
    }
    // accept only a clean current-price key; skip anything per-unit / was / rrp / historic
    const isPriceKey = (kl === "price" || kl === "currentprice" || kl === "current_price" || kl === "priceinpence" || kl === "amount");
    const isBadPriceKey = kl.includes("unit") || kl.includes("was") || kl.includes("rrp") || kl.includes("litre") || kl.includes("perl") || kl.includes("history") || kl.includes("low") || kl.includes("high") || kl.includes("avg");
    if (isPriceKey && !isBadPriceKey && (typeof v === "number" || (typeof v === "string" && /^\s*£?\s*\d+(\.\d{1,2})?\s*$/.test(v)))) {
      let p = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.]/g, ""));
      if (kl.includes("pence") && p > 100) p = p / 100; // pence -> pounds
      if (!isNaN(p) && p >= 2 && p < 500) price = p;
    }
  }

  if (retailerName && price != null) {
    const r = normaliseRetailer(retailerName);
    if (r && !out[r]) out[r] = { stocked: true, price, source: "trolley.co.uk" };
  }
  for (const k of keys) harvestPrices(node[k], out, depth + 1);
}

async function scrapeWine(wineName) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let captured = [];

  try {
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36");
    await page.setViewport({ width: 1200, height: 900 });

    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("application/json")) return;
        if (!/trolley\.co\.uk/i.test(res.url())) return;
        const text = await res.text();
        if (text && /price/i.test(text)) captured.push(text);
      } catch (_) {}
    });

    // 1) search
    const searchUrl = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(wineName)}`;
    console.log(`[scrape] ${wineName}`);
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 25000 });

    // 2) pick the best-matching product link
    const queryTerms = wineName.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const candidates = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/product/"]'));
      const seen = {};
      const out = [];
      for (const a of links) {
        const href = a.href;
        if (seen[href]) continue;
        seen[href] = true;
        const title = (a.textContent || "").trim().replace(/\s+/g, " ");
        if (title) out.push({ href, title });
      }
      return out.slice(0, 15);
    });

    let best = null, bestScore = -1;
    for (const c of candidates) {
      const s = matchScore(c.title, queryTerms, wineName);
      if (s > bestScore) { bestScore = s; best = c; }
    }

    if (!best || bestScore < 0) {
      console.log(`[scrape] ${wineName}: no matching product`);
      await page.close();
      return null;
    }

    // 3) load that product page, capturing ONLY its price JSON
    captured = [];
    console.log(`[scrape] matched: ${best.title}`);
    await page.goto(best.href, { waitUntil: "networkidle2", timeout: 25000 });
    await new Promise((r) => setTimeout(r, 1800));

    const results = {};
    for (const text of captured) {
      try { harvestPrices(JSON.parse(text), results); } catch (_) {}
    }

    await page.close();

    if (Object.keys(results).length > 0) {
      console.log(`[scrape] ${wineName}: ${Object.keys(results).length} retailers`);
      return { matchedProduct: best.title, prices: results };
    }
    console.log(`[scrape] ${wineName}: matched product but no clean prices`);
    return { matchedProduct: best.title, prices: {} };
  } catch (e) {
    console.error(`[scrape] ${wineName} error:`, e.message);
    try { await page.close(); } catch (_) {}
    return null;
  }
}

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.get("/test", async (req, res) => {
  const wine = req.query.wine || "Whispering Angel";
  const out = await scrapeWine(String(wine));
  res.json({ wine, result: out });
});

app.post("/prices", async (req, res) => {
  const { wines } = req.body;
  if (!Array.isArray(wines)) return res.status(400).json({ error: "wines must be an array" });
  if (wines.length > 25) return res.status(400).json({ error: "max 25 wines" });

  const cache = loadCache();
  const results = {};
  let fetched = 0, cached = 0;

  for (const w of wines) {
    const name = String(w.name || w).trim();
    if (!name) continue;
    const key = name.toLowerCase();

    if (cache[key] && fresh(cache[key])) {
      results[name] = cache[key].data;
      cached++;
      continue;
    }

    const out = await scrapeWine(name);
    const prices = out && out.prices && Object.keys(out.prices).length ? out.prices : null;
    cache[key] = { data: prices, at: new Date().toISOString(), matched: out?.matchedProduct || null };
    results[name] = prices;
    if (prices) fetched++;
    saveCache(cache);
    await new Promise((r) => setTimeout(r, 800));
  }

  res.json({ results, fetched, cached, note: `Fetched ${fetched}, ${cached} cached (7-day). Live from Trolley.co.uk.` });
});

app.listen(PORT, () => console.log(`Wine backend (Puppeteer, strict) on :${PORT}`));
