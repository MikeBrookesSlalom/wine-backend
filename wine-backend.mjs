bash

cat /home/claude/wine-backend.mjs
Output

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

    // Strategy 1: Look for structured data / JSON-LD
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">({[\s\S]*?})<\/script>/i);
    if (jsonLdMatch) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        console.log(`[Trolley] Found JSON-LD for ${wineName}`);
        // Could extract prices from JSON-LD here
      } catch (e) {
        console.warn(`[Trolley] JSON-LD parse failed: ${e.message}`);
      }
    }

    // Strategy 2: Look for price patterns more aggressively
    const results = {};
    const retailers = [
      { name: "Tesco", patterns: ["tesco", "tesco.com"] },
      { name: "Sainsbury's", patterns: ["sainsbury", "sainsburys.co.uk"] },
      { name: "ASDA", patterns: ["asda", "asda.com"] },
      { name: "Waitrose", patterns: ["waitrose", "waitrose.com"] },
      { name: "M&S", patterns: ["m&s", "ocado"] },
    ];

    for (const retailer of retailers) {
      // Look for the retailer name followed by any price-like pattern
      // Prices can be in various formats: £8.50, 8.50, etc.
      const patterns = [
        new RegExp(`${retailer.patterns[0]}[^£]*£\\s*([0-9.]+)`, "gi"),
        new RegExp(`£\\s*([0-9.]+)[^£]*${retailer.patterns[0]}`, "gi"),
        // Also try patterns without currency symbol
        new RegExp(`${retailer.patterns[0]}[^0-9]*(\\d+\\.\\d{2})[^0-9]*(?:per|each)?`, "gi"),
      ];

      for (const pattern of patterns) {
        const match = pattern.exec(html);
        if (match) {
          const price = parseFloat(match[1]);
          if (!isNaN(price) && price > 0 && price < 100) {
            results[retailer.name] = {
              stocked: true,
              price: Math.round(price * 100) / 100,
              source: "trolley.co.uk",
            };
            console.log(`[Trolley] ${retailer.name}: £${price}`);
            break; // Found price for this retailer, move to next
          }
        }
      }
    }

    // If we found at least one price, return it
    if (Object.keys(results).length > 0) {
      console.log(`[Trolley] Found ${Object.keys(results).length} retailers for ${wineName}`);
      return results;
    }

    // Strategy 3: Try alternative search (some wines may not be on Trolley)
    // Return empty object instead of null to indicate "checked but not found"
    console.log(`[Trolley] No prices found for "${wineName}" on Trolley`);
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
      // Cache a miss too, so we don't hammer Trolley for unknown wines
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
Done
