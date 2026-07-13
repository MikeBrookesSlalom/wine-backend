import express from "express";
import * as fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const ACTOR = "crawlerbros~trolley-grocery-price-scraper";
const CACHE_FILE = "/tmp/price-cache.json";
const PRICE_TTL = 7 * 24 * 60 * 60 * 1000;   // prices: 7 days
const ID_TTL = 90 * 24 * 60 * 60 * 1000;      // productId mapping: 90 days

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ---------- cache ---------- */
function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch (e) { console.warn("cache load:", e.message); }
  return {};
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch (e) { console.warn("cache save:", e.message); }
}
const ageOk = (ts, ttl) => ts && Date.now() - new Date(ts).getTime() < ttl;

/* ---------- Apify ---------- */
async function runActor(input) {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not set");
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Apify ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

function normaliseRetailer(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("tesco")) return "Tesco";
  if (n.includes("sainsbury")) return "Sainsbury's";
  if (n.includes("asda")) return "ASDA";
  if (n.includes("waitrose")) return "Waitrose";
  if (n.includes("m&s") || n.includes("marks") || n.includes("ocado")) return "M&S";
  return null; // ignore Morrisons/Aldi/etc — not tracked in the app
}

const VARIANT_WORDS = ["the pale","the beach","rock angel","magnum","limited edition","gift","jeroboam","personalised","case of"];
const SMALL_FORMATS = ["37.5cl","18.7cl","187ml","25cl","20cl","half"];

/* choose the product record that best matches the wine name, preferring 75cl */
function pickBest(items, wineName) {
  const terms = wineName.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  let best = null, bestScore = -1;
  for (const it of items) {
    const name = String(it.name || "").toLowerCase();
    const size = String(it.size || "").toLowerCase();
    if (!name) continue;
    if (!terms.every((w) => name.includes(w))) continue; // must contain all query words
    let score = 100;
    if (size.includes("75cl") || size.includes("750ml") || name.includes("75cl")) score += 30;
    for (const sf of SMALL_FORMATS) { if ((size.includes(sf) || name.includes(sf)) && !wineName.toLowerCase().includes(sf)) score -= 70; }
    for (const vw of VARIANT_WORDS) { if (name.includes(vw) && !wineName.toLowerCase().includes(vw)) score -= 45; }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 0 ? best : null;
}

/* reshape Apify storePrices[] -> { Tesco: {stocked, price, ...}, ... } */
function reshape(storePrices) {
  const out = {};
  for (const sp of storePrices || []) {
    const r = normaliseRetailer(sp.store);
    if (!r) continue;
    const price = typeof sp.price === "number" ? sp.price : parseFloat(String(sp.price).replace(/[^\d.]/g, ""));
    if (isNaN(price) || price <= 0) continue;
    if (!out[r] || price < out[r].price) {
      out[r] = {
        stocked: true,
        price,
        source: "trolley.co.uk",
        offer: sp.promotionalOffer || null,
      };
    }
  }
  return out;
}

/* ---------- core ---------- */
async function resolveProductId(wineName) {
  const items = await runActor({
    mode: "search",
    searchQuery: wineName,
    sortOrder: "relevance",
    maxItems: 12,
  });
  const best = pickBest(items, wineName);
  return best ? { productId: best.productId, matchedName: best.name } : null;
}

async function fetchPricesForIds(idList) {
  if (!idList.length) return {};
  const items = await runActor({ mode: "byProductIds", productIds: idList });
  const byId = {};
  for (const it of items) {
    if (it.productId) byId[it.productId] = reshape(it.storePrices);
  }
  return byId;
}

/* ---------- routes ---------- */
app.get("/health", (req, res) =>
  res.json({ status: "ok", uptime: process.uptime(), tokenSet: !!APIFY_TOKEN }));

app.get("/test", async (req, res) => {
  try {
    const wine = req.query.wine || "Whispering Angel";
    const resolved = await resolveProductId(String(wine));
    if (!resolved) return res.json({ wine, matched: null, prices: {} });
    const priceMap = await fetchPricesForIds([resolved.productId]);
    res.json({ wine, matched: resolved.matchedName, productId: resolved.productId, prices: priceMap[resolved.productId] || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/prices", async (req, res) => {
  try {
    const { wines } = req.body;
    if (!Array.isArray(wines)) return res.status(400).json({ error: "wines must be an array" });
    if (wines.length > 25) return res.status(400).json({ error: "max 25 wines" });

    const cache = loadCache();
    const results = {};
    const needPrice = []; // { name, productId }
    let cached = 0;

    // Step 1: resolve productIds (from cache or via search)
    for (const w of wines) {
      const name = String(w.name || w).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = cache[key] || {};

      // fresh price cache -> use directly
      if (entry.priceAt && ageOk(entry.priceAt, PRICE_TTL) && entry.data) {
        results[name] = entry.data;
        cached++;
        continue;
      }

      // have a valid productId mapping?
      let productId = ageOk(entry.idAt, ID_TTL) ? entry.productId : null;
      if (!productId) {
        const resolved = await resolveProductId(name);
        if (resolved) {
          productId = resolved.productId;
          cache[key] = { ...entry, productId, matchedName: resolved.matchedName, idAt: new Date().toISOString() };
        } else {
          cache[key] = { ...entry, productId: null, idAt: new Date().toISOString() };
          results[name] = null;
          continue;
        }
      }
      needPrice.push({ name, key, productId });
    }

    // Step 2: one batched byProductIds call for everything that needs fresh prices
    if (needPrice.length) {
      const idList = [...new Set(needPrice.map((n) => n.productId))];
      const priceMap = await fetchPricesForIds(idList);
      for (const n of needPrice) {
        const data = priceMap[n.productId] || null;
        results[n.name] = data;
        cache[n.key] = { ...cache[n.key], data, priceAt: new Date().toISOString() };
      }
    }

    saveCache(cache);
    res.json({
      results,
      fetched: needPrice.length,
      cached,
      note: `Fetched ${needPrice.length}, ${cached} from 7-day cache. Live via Apify/Trolley.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Wine backend (Apify) on :${PORT} — token ${APIFY_TOKEN ? "set" : "MISSING"}`));
