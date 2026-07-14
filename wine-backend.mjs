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

// Map any Trolley store name to a short key. Returns the name for all tracked supermarkets.
const STORE_MAP = [
  ["tesco", "Tesco"],
  ["sainsbury", "Sainsbury's"],
  ["asda", "ASDA"],
  ["waitrose", "Waitrose"],
  ["ocado", "M&S"],        // M&S groceries sell via Ocado
  ["marks", "M&S"],
  ["m&s", "M&S"],
  ["morrison", "Morrisons"],
  ["aldi", "Aldi"],
  ["lidl", "Lidl"],
  ["co-op", "Co-op"],
  ["coop", "Co-op"],
  ["iceland", "Iceland"],
  ["amazon", "Amazon"],
];
function normaliseRetailer(name) {
  const n = String(name || "").toLowerCase();
  for (const [needle, label] of STORE_MAP) { if (n.includes(needle)) return label; }
  return null;
}

const VARIANT_WORDS = ["the pale","the beach","rock angel","magnum","limited edition","gift","jeroboam","personalised","case of"];
const SMALL_FORMATS = ["37.5cl","18.7cl","187ml","25cl","20cl","half"];
const LARGE_FORMATS = ["150cl","100cl","1.5l","1.5 l","3l","3 l","magnum","jeroboam","double magnum"];

/* choose the product record that best matches the wine name, preferring standard 75cl */
function pickBest(items, wineName) {
  const ql = wineName.toLowerCase();
  const terms = ql.split(/\s+/).filter((w) => w.length > 1);
  let best = null, bestScore = -1;
  for (const it of items) {
    const name = String(it.name || "").toLowerCase();
    const brand = String(it.brand || "").toLowerCase();
    const desc = String(it.description || "").toLowerCase();
    const size = String(it.size || "").toLowerCase();
    const hay = `${brand} ${name} ${desc}`;

    if (!size.includes("cl")) continue;                 // wine bottles are in cl on Trolley -> filters cosmetics
    if (!terms.every((w) => hay.includes(w))) continue;  // all query words present across brand+name+desc

    let score = 100;
    if (size.includes("75cl") || size.includes("750ml")) score += 30;
    for (const sf of SMALL_FORMATS) { if (size.includes(sf) && !ql.includes(sf)) score -= 70; }
    for (const lf of LARGE_FORMATS) { if ((size.includes(lf) || hay.includes(lf)) && !ql.includes(lf)) score -= 70; }
    for (const vw of VARIANT_WORDS) { if (hay.includes(vw) && !ql.includes(vw)) score -= 45; }
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

/* ---------- Majestic Wine (direct, not on Trolley) ---------- */
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

// pull every JSON-LD block from a page and return parsed objects
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch (_) {}
  }
  return blocks;
}

// find a Product price inside parsed JSON-LD (schema.org)
function priceFromJsonLd(blocks) {
  const walk = (node) => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const n of node) { const r = walk(n); if (r) return r; } return null; }
    const type = node["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    if (isProduct && node.offers) {
      const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
      for (const o of offers) {
        const p = o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price);
        if (p != null) {
          const num = parseFloat(String(p).replace(/[^\d.]/g, ""));
          if (!isNaN(num) && num > 0) return { price: num, name: node.name || null };
        }
      }
    }
    for (const k of Object.keys(node)) { const r = walk(node[k]); if (r) return r; }
    return null;
  };
  return walk(blocks);
}

async function scrapeMajestic(wineName, wantDebug = false) {
  const debug = { steps: [] };
  try {
    const searchUrl = `https://www.majestic.co.uk/search?q=${encodeURIComponent(wineName)}`;
    const sRes = await fetch(searchUrl, { headers: BROWSER_HEADERS, redirect: "follow" });
    debug.searchUrl = searchUrl;
    debug.searchStatus = sRes.status;
    if (!sRes.ok) {
      debug.steps.push(`search HTTP ${sRes.status}`);
      return { price: null, debug };
    }
    const sHtml = await sRes.text();
    debug.searchHtmlLength = sHtml.length;

    // find the first product link (Majestic product URLs contain /wines/ or /product or an id)
    const linkMatch =
      sHtml.match(/href=["'](https?:\/\/www\.majestic\.co\.uk)?(\/[^"']*?(?:wines?|product)[^"']*?-\d{3,}[^"']*?)["']/i) ||
      sHtml.match(/href=["'](https?:\/\/www\.majestic\.co\.uk)?(\/[^"']*?\/\d{4,}[^"']*?)["']/i);
    if (!linkMatch) {
      debug.steps.push("no product link found in search HTML");
      if (wantDebug) debug.searchSnippet = sHtml.slice(0, 1500);
      return { price: null, debug };
    }
    const productUrl = (linkMatch[1] || "https://www.majestic.co.uk") + linkMatch[2];
    debug.productUrl = productUrl;

    const pRes = await fetch(productUrl, { headers: BROWSER_HEADERS, redirect: "follow" });
    debug.productStatus = pRes.status;
    if (!pRes.ok) { debug.steps.push(`product HTTP ${pRes.status}`); return { price: null, debug }; }
    const pHtml = await pRes.text();

    const jsonLd = extractJsonLd(pHtml);
    debug.jsonLdBlocks = jsonLd.length;
    const found = priceFromJsonLd(jsonLd);
    if (found) {
      debug.steps.push("price from JSON-LD");
      return { price: found.price, matchedName: found.name, url: productUrl, debug };
    }

    // fallback: look for a price in the raw HTML meta or price tags
    const metaPrice = pHtml.match(/itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i) ||
                      pHtml.match(/"price"\s*:\s*"?([\d.]+)"?/i);
    if (metaPrice) {
      debug.steps.push("price from meta/regex");
      return { price: parseFloat(metaPrice[1]), url: productUrl, debug };
    }

    debug.steps.push("product page had no parseable price");
    if (wantDebug) debug.productSnippet = pHtml.slice(0, 1500);
    return { price: null, debug };
  } catch (e) {
    debug.error = e.message;
    return { price: null, debug };
  }
}

/* ---------- routes ---------- */
app.get("/health", (req, res) =>
  res.json({ status: "ok", uptime: process.uptime(), tokenSet: !!APIFY_TOKEN }));

app.get("/majestic-test", async (req, res) => {
  const wine = req.query.wine || "Whispering Angel";
  const out = await scrapeMajestic(String(wine), req.query.debug === "1");
  res.json({ wine, ...out });
});

/* ---------- Monthly wine list (Luke Flunder's Substack) ----------
   We extract FACTS ONLY: wine name, retailer, style, buy link, and his
   NEW/STAR PICK/PRICE DROP tags. We deliberately do NOT scrape or store
   his written tasting-note commentary — that's his original editorial
   content, and reproducing it wholesale every month isn't something we
   should do even for personal use. The app links back to his post so
   people can read his actual notes there. */
const WINE_LIST_URL = "https://lukeflunder.substack.com/p/the-list";
const LIST_CACHE_FILE = "/tmp/wine-list-cache.json";
const LIST_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days — monthly content, refreshed often enough to catch updates

const RETAILER_CANON = [
  ["waitrose", "Waitrose"], ["majestic", "Majestic"], ["tesco", "Tesco"],
  ["m&s", "M&S / Ocado"], ["ocado", "M&S / Ocado"], ["marks", "M&S / Ocado"],
  ["sainsbury", "Sainsbury's"], ["morrisons", "Morrisons"], ["aldi", "Aldi"],
  ["asda", "ASDA"], ["co-op", "Co-op"], ["coop", "Co-op"], ["lidl", "Lidl"],
  ["costco", "Costco"], ["low & no", "Low & No"], ["low and no", "Low & No"],
];
function canonicalRetailer(line) {
  const t = line.trim().toLowerCase().replace(/[^a-z0-9&,\s|]/g, "");
  if (!t || t.length > 40) return null;
  for (const [needle, canon] of RETAILER_CANON) if (t.includes(needle)) return canon;
  return null;
}
function htmlToLines(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, inner) => {
    const innerText = inner.replace(/<[^>]+>/g, "");
    return `${innerText}⟦${url}⟧`;
  });
  s = s.replace(/<\/(h1|h2|h3|h4|h5|h6|li|p|div)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;/g, "'")
       .replace(/&rdquo;|&ldquo;/g, '"').replace(/&nbsp;/g, " ");
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}
const TAG_WORDS = ["STAR PICK", "PRICE DROP", "TOP PICK", "NEW"]; // longer phrases checked first
function stripLeadingTag(line) {
  const upper = line.toUpperCase();
  for (const tw of TAG_WORDS) {
    if (upper.startsWith(tw)) return { tag: tw, rest: line.slice(tw.length).replace(/^\s+/, "") };
  }
  return { tag: null, rest: line };
}
function parseWineListLines(lines) {
  let month = null;
  const head = lines.slice(0, 15).join(" ");
  let m = head.match(/THE\s+L.ST\s*-\s*([A-Za-z]+)\s+(\d{4})/i);
  if (!m) m = head.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\D{0,10}(20\d{2})/i);
  if (m) month = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;

  const sections = [];
  let current = null;

  for (const raw of lines) {
    const retailer = canonicalRetailer(raw);
    if (retailer) {
      current = sections.find((s) => s.retailer === retailer);
      if (!current) { current = { retailer, wines: [] }; sections.push(current); }
      continue;
    }
    if (!current || !raw.includes("⟦")) continue;

    const { tag, rest } = stripLeadingTag(raw);
    const line = rest;

    const linkRe = /([^⟦]*)⟦([^⟧]+)⟧/g;
    let lm, chosen = null;
    const spans = [];
    while ((lm = linkRe.exec(line)) !== null) {
      spans.push({ full: lm[0], name: lm[1].trim(), url: lm[2] });
      if (!chosen && lm[1].trim() && !/^https?:\/\//i.test(lm[1].trim())) chosen = { name: lm[1].trim(), url: lm[2] };
    }
    if (!chosen && spans.length) chosen = spans[spans.length - 1];
    if (!chosen) continue;

    let remainder = line;
    for (const sp of spans) remainder = remainder.replace(sp.full, " ");

    let style = null, offerCode = null;
    const styleMatch = remainder.match(/(?:(CC|NP|MC|AR)\s*)?\(\s*(S|W|R|Ro)\s*\)/i);
    if (styleMatch) {
      offerCode = styleMatch[1] ? styleMatch[1].toUpperCase() : null;
      style = styleMatch[2][0].toUpperCase() + styleMatch[2].slice(1).toLowerCase();
    }

    current.wines.push({ tag, name: chosen.name, url: chosen.url, style, offerCode });
  }
  return { month, sections };
}

function loadListCache() {
  try { if (fs.existsSync(LIST_CACHE_FILE)) return JSON.parse(fs.readFileSync(LIST_CACHE_FILE, "utf8")); }
  catch (e) { console.warn("list cache load:", e.message); }
  return null;
}
function saveListCache(obj) {
  try { fs.writeFileSync(LIST_CACHE_FILE, JSON.stringify(obj)); } catch (e) { console.warn("list cache save:", e.message); }
}

async function fetchWineListHtml() {
  const res = await fetch(WINE_LIST_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching wine list`);
  return res.text();
}

app.get("/wine-list", async (req, res) => {
  try {
    const cached = loadListCache();
    if (cached && Date.now() - new Date(cached.at).getTime() < LIST_TTL) {
      return res.json({ ...cached.data, cached: true });
    }
    const html = await fetchWineListHtml();
    const lines = htmlToLines(html);
    const parsed = parseWineListLines(lines);
    saveListCache({ data: parsed, at: new Date().toISOString() });
    res.json({ ...parsed, cached: false });
  } catch (e) {
    // fall back to stale cache rather than a hard failure, if we have one
    const cached = loadListCache();
    if (cached) return res.json({ ...cached.data, cached: true, stale: true, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get("/wine-list-debug", async (req, res) => {
  try {
    const html = await fetchWineListHtml();
    const lines = htmlToLines(html);
    const parsed = parseWineListLines(lines);
    res.json({
      month: parsed.month,
      lineCount: lines.length,
      sectionsFound: parsed.sections.map((s) => ({ retailer: s.retailer, wineCount: s.wines.length })),
      firstLines: lines.slice(0, 30),
      sampleWines: parsed.sections.slice(0, 2).map((s) => ({ retailer: s.retailer, wines: s.wines.slice(0, 3) })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/test", async (req, res) => {
  try {
    const wine = req.query.wine || "Whispering Angel";
    const wantDebug = req.query.debug === "1";

    const items = await runActor({ mode: "search", searchQuery: String(wine), sortOrder: "relevance", maxItems: 12 });
    const best = pickBest(items, String(wine));

    if (wantDebug) {
      const candidates = items.map((it) => ({ productId: it.productId, name: it.name, brand: it.brand, description: it.description, size: it.size, price: it.price }));
      return res.json({ wine, matched: best?.name || null, matchedBrand: best?.brand || null, productId: best?.productId || null, candidates });
    }

    if (!best) return res.json({ wine, matched: null, prices: {} });

    // raw=1 dumps the untouched byProductIds output so we can see the real field names
    if (req.query.raw === "1") {
      const rawItems = await runActor({ mode: "byProductIds", productIds: [best.productId] });
      return res.json({ wine, matched: best.name, productId: best.productId, rawByProductIds: rawItems });
    }

    const priceMap = await fetchPricesForIds([best.productId]);
    res.json({ wine, matched: best.name, productId: best.productId, prices: priceMap[best.productId] || {} });
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
        // only cache real results; empty/blank stays uncached so it retries next check
        if (data && Object.keys(data).length > 0) {
          cache[n.key] = { ...cache[n.key], data, priceAt: new Date().toISOString() };
        } else if (cache[n.key]) {
          delete cache[n.key].data;
          delete cache[n.key].priceAt;
        }
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
