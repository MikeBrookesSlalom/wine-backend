import express from "express";
import puppeteer from "puppeteer";
import * as fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = "/tmp/price-cache.json";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days (weekly refresh use case)

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ============ Cache ============ */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) { console.warn("cache load:", e.message); }
  return {};
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); }
  catch (e) { console.warn("cache save:", e.message); }
}
function fresh(entry) {
  return entry && entry.at && Date.now() - new Date(entry.at).getTime() < CACHE_TTL;
}

/* ============ Browser (single shared instance) ============ */
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
    });
  }
  return browserPromise;
}

const RETAILER_KEYS = ["Tesco", "Sainsbury's", "Sainsburys", "ASDA", "Asda", "Waitrose", "M&S", "Marks", "Ocado", "Morrisons"];

function normaliseRetailer(name) {
  const n = name.toLowerCase();
  if (n.includes("tesco")) return "Tesco";
  if (n.includes("sainsbury")) return "Sainsbury's";
  if (n.includes("asda")) return "ASDA";
  if (n.includes("waitrose")) return "Waitrose";
  if (n.includes("m&s") || n.includes("marks") || n.includes("ocado")) return "M&S";
  return null;
}

/* ============ Scrape one wine ============ */
async function scrapeWine(wineName) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const captured = []; // JSON blobs intercepted from network

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
    );
    await page.setViewport({ width: 1200, height: 900 });

    // Intercept JSON responses — this is where the real price data lives
    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("application/json")) return;
        const url = res.url();
        // Only bother with same-site API-ish calls
        if (!/trolley\.co\.uk/i.test(url)) return;
        const text = await res.text();
        if (text && (text.includes("price") || text.includes("Price") || text.includes("£"))) {
          captured.push({ url, text });
        }
      } catch (_) {}
    });

    const searchUrl = `https://www.trolley.co.uk/search/?q=${encodeURIComponent(wineName)}`;
    console.log(`[scrape] ${wineName} -> ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 25000 });

    // Try to land on the first product to get its full retailer comparison
    let productHref = null;
    try {
      productHref = await page.evaluate(() => {
        const a = document.querySelector('a[href*="/product/"]');
        return a ? a.href : null;
      });
    } catch (_) {}

    if (productHref) {
      console.log(`[scrape] product: ${productHref}`);
      await page.goto(productHref, { waitUntil: "networkidle2", timeout: 25000 });
      await new Promise((r) => setTimeout(r, 1500)); // let price widgets settle
    }

    // Strategy 1: parse intercepted JSON for retailer/price pairs
    const results = {};
    for (const blob of captured) {
      try {
        const data = JSON.parse(blob.text);
        harvestPrices(data, results);
      } catch (_) {}
    }

    // Strategy 2: DOM extraction fallback
    if (Object.keys(results).length === 0) {
      const domRows = await page.evaluate(() => {
        const out = [];
        // grab any element whose text contains £ and sits near a retailer name
        const all = Array.from(document.querySelectorAll("*"));
        for (const el of all) {
          const t = (el.textContent || "").trim();
          if (t.length > 0 && t.length < 60 && /£\s?\d+\.\d{2}/.test(t)) {
            out.push(t);
          }
        }
        return out.slice(0, 200);
      });
      // Try to associate retailer names with prices from surrounding text
      const pageText = await page.evaluate(() => document.body.innerText || "");
      for (const key of ["Tesco", "Sainsbury", "Asda", "ASDA", "Waitrose", "Ocado", "M&S"]) {
        const re = new RegExp(`${key}[^£]{0,40}£\\s?(\\d+\\.\\d{2})`, "i");
        const m = pageText.match(re);
        if (m) {
          const r = normaliseRetailer(key);
          const price = parseFloat(m[1]);
          if (r && !results[r] && price > 0 && price < 200) {
            results[r] = { stocked: true, price, source: "trolley.co.uk" };
          }
        }
      }
    }

    await page.close();

    if (Object.keys(results).length > 0) {
      console.log(`[scrape] ${wineName}: found ${Object.keys(results).length} retailers`);
      return results;
    }
    console.log(`[scrape] ${wineName}: no prices`);
    return null;
  } catch (e) {
    console.error(`[scrape] ${wineName} error:`, e.message);
    try { await page.close(); } catch (_) {}
    return null;
  }
}

/* Recursively walk a JSON object looking for retailer + price shapes */
function harvestPrices(node, out, depth = 0) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) harvestPrices(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    // Look for a retailer name + a price on the same object
    const keys = Object.keys(node);
    let retailerName = null;
    let price = null;
    for (const k of keys) {
      const v = node[k];
      const kl = k.toLowerCase();
      if (typeof v === "string" && (kl.includes("retailer") || kl.includes("merchant") || kl.includes("store") || kl.includes("shop") || kl.includes("seller"))) {
        retailerName = v;
      }
      if ((kl === "price" || kl.includes("price")) && (typeof v === "number" || (typeof v === "string" && /\d/.test(v)))) {
        const p = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.]/g, ""));
        if (!isNaN(p) && p > 0 && p < 500) price = p;
      }
    }
    if (retailerName && price != null) {
      const r = normaliseRetailer(retailerName);
      if (r && !out[r]) out[r] = { stocked: true, price, source: "trolley.co.uk" };
    }
    for (const k of keys) harvestPrices(node[k], out, depth + 1);
  }
}

/* ============ API ============ */
app.get("/health", async (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/test", async (req, res) => {
  const wine = req.query.wine || "Whispering Angel";
  const prices = await scrapeWine(String(wine));
  res.json({ wine, prices });
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

    const prices = await scrapeWine(name);
    cache[key] = { data: prices, at: new Date().toISOString() };
    results[name] = prices;
    if (prices) fetched++;
    saveCache(cache);
    await new Promise((r) => setTimeout(r, 800)); // polite pause
  }

  res.json({
    results,
    fetched,
    cached,
    note: `Fetched ${fetched}, ${cached} from cache (7-day). Live from Trolley.co.uk.`,
  });
});

app.listen(PORT, () => {
  console.log(`Wine backend (Puppeteer) on :${PORT}`);
});
