import express from "express";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = "price-cache.json";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ============ Cache helpers ============ */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Cache load failed:", e.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e.message);
  }
}

function isCacheFresh(cached) {
  return cached && cached.at && Date.now() - new Date(cached.at).getTime() < CACHE_TTL;
}

/* ============ Trolley scraper ============ */
async function scrapeTrolley(wineName) {
  try {
    const q = encodeURIComponent(wineName);
    const url = `https://www.trolley.co.uk/search/?q=${q}`;
    console.log(`[Trolley] Fetching: ${url}`);

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    if (!res.ok) {
      console.warn(`[Trolley] HTTP ${res.status} for ${wineName}`);
      return null;
    }

    const html = await res.text();

    const results = {};
    const retailers = [
      { name: "Tesco", search: "tesco" },
      { name: "Sainsbury's", search: "sainsbury" },
      { name: "ASDA", search: "asda" },
      { name: "Waitrose", search: "waitrose" },
      { name: "M&S", search: "ocado" },
    ];

    for (const retailer of retailers) {
      // Simple price pattern: look for £ followed by digits
      const regex = new RegExp(`${retailer.search}[^£]*£\\s*([0-9.]+)`, "i");
      const match = html.match(regex);

      if (match) {
        const price = parseFloat(match[1]);
        if (!isNaN(price) && price > 0 && price < 100) {
          results[retailer.name] = {
            stocked: true,
            price: Math.round(price * 100) / 100,
            source: "trolley.co.uk",
          };
          console.log(`[Trolley] ${retailer.name}: £${price}`);
        }
      }
    }

    if (Object.keys(results).length > 0) {
      console.log(`[Trolley] Found ${Object.keys(results).length} retailers for ${wineName}`);
      return results;
    }

    console.log(`[Trolley] No prices found for "${wineName}"`);
    return null;
  } catch (e) {
    console.error(`[Trolley] Error scraping ${wineName}:`, e.message);
    return null;
  }
}

/* ============ API endpoints ============ */
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.post("/prices", async (req, res) => {
  const { wines } = req.body;

  if (!Array.isArray(wines)) {
    return res.status(400).json({ error: "wines must be an array" });
  }

  if (wines.length > 20) {
    return res.status(400).json({ error: "max 20 wines per request" });
  }

  const cache = loadCache();
  const results = {};
  let fetched = 0;
  let cached = 0;

  for (const wine of wines) {
    const name = String(wine.name || wine).trim();
    if (!name) continue;

    const cacheKey = name.toLowerCase();

    // Try cache first
    if (cache[cacheKey] && isCacheFresh(cache[cacheKey])) {
      results[name] = cache[cacheKey].data;
      cached++;
      continue;
    }

    // Fetch from Trolley
    const prices = await scrapeTrolley(name);
    if (prices) {
      const entry = { data: prices, at: new Date().toISOString() };
      cache[cacheKey] = entry;
      results[name] = prices;
      fetched++;
    } else {
      cache[cacheKey] = { data: null, at: new Date().toISOString() };
      results[name] = null;
    }

    // Polite throttle
    await new Promise((r) => setTimeout(r, 500));
  }

  saveCache(cache);

  res.json({
    results,
    cached,
    fetched,
    note: `Fetched ${fetched} wines, ${cached} from cache. Prices are point-in-time; check Trolley for current.`,
  });
});

/* ============ Startup ============ */
app.listen(PORT, () => {
  console.log(`Wine price backend listening on port ${PORT}`);
  console.log(`POST /prices with { wines: [{name: "..."}, ...] }`);
});
