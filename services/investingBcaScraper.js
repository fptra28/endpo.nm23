// services/investingBcaScraper.js
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");

const CACHE_TTL_MS = Number(process.env.CNBC_CACHE_TTL_MS || 60 * 1000);
let cache = { at: 0, payload: null };

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const { getCache, setCache } = require("./cacheStore");

const CNBC_BASE = "https://www.cnbcindonesia.com/market-data/quote";
const QUOTES = [
    { symbol: "BBCA" },
    { symbol: "BBRI" },
    { symbol: "BMRI" },
    { symbol: "TLKM" },
    { symbol: "ASII" },
    { symbol: "BBNI" },
    { symbol: "UNVR" },
    { symbol: "ICBP" },
    { symbol: "ADRO" },
    { symbol: "GOTO" },
];

const CACHE_KEY = "cnbc_quotes";
const CACHE_KEY_BBCA = "cnbc_quote_bbca";

function buildCnbcUrl(symbol) {
    const code = `${symbol}.JK`;
    return `${CNBC_BASE}/${code}/${symbol}`;
}

function parseLocaleNumber(input) {
    if (!input) return null;
    const raw = String(input).trim();
    if (!raw) return null;

    let s = raw.replace(/\s+/g, "").replace(/[^\d.,-]/g, "");
    if (!s) return null;

    const hasComma = s.includes(",");
    const hasDot = s.includes(".");

    if (hasComma && hasDot) {
        if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
            // 2.345,67 -> 2345.67
            s = s.replace(/\./g, "").replace(",", ".");
        } else {
            // 2,345.67 -> 2345.67
            s = s.replace(/,/g, "");
        }
    } else if (hasComma && !hasDot) {
        // 6,900 -> 6900
        if (/^-?\d{1,3}(,\d{3})+$/.test(s)) {
            s = s.replace(/,/g, "");
        } else {
            // 10,5 -> 10.5
            s = s.replace(",", ".");
        }
    } else if (!hasComma && hasDot) {
        // 3.610 -> 3610
        if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
            s = s.replace(/\./g, "");
        }
    } else {
        s = s.replace(/,/g, "");
    }

    const num = Number(s);
    return Number.isFinite(num) ? num : null;
}

async function axiosGetWithRetry(url, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await axios.get(url, {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                },
                timeout: 20000,
                httpAgent,
                httpsAgent,
                decompress: true,
                maxRedirects: 5,
                validateStatus: (s) => s >= 200 && s < 400,
            });
            return res.data;
        } catch (err) {
            lastErr = err;
            if (i === tries) throw lastErr;
            await new Promise((r) => setTimeout(r, 400 * i));
        }
    }
}

function scrapeCnbcQuote(html) {
    const $ = cheerio.load(html);
    const getMeta = (prop) => $(`meta[property="${prop}"]`).attr("content") || null;

    const kode = getMeta("market:kode");
    const nama = getMeta("market:nama");
    const price = getMeta("market:price");
    const change = getMeta("market:price_change");
    const percent = getMeta("market:percent");

    if (!price) {
        throw new Error("Harga tidak ditemukan di meta market:price");
    }

    const symbol = kode ? String(kode).split(".")[0] : null;

    return {
        symbol,
        name: nama || null,
        last: parseLocaleNumber(price),
        change: parseLocaleNumber(change),
        change_percent: parseLocaleNumber(percent),
        currency: "IDR",
        raw: { kode, nama, price, change, percent },
    };
}

async function fetchCnbcSingle({ symbol }) {
    const url = buildCnbcUrl(symbol);
    const html = await axiosGetWithRetry(url, 3);
    const data = scrapeCnbcQuote(html);

    return {
        source: url,
        symbol: data.symbol || symbol,
        name: data.name,
        last: data.last,
        change: data.change,
        change_percent: data.change_percent,
        currency: data.currency,
        raw: data.raw,
        fetched_at: new Date().toISOString(),
    };
}

async function fetchInvestingBcaCached({ bypassCache = false } = {}) {
    const now = Date.now();

    if (!bypassCache) {
        try {
            const cachedSingle = await getCache(CACHE_KEY_BBCA);
            if (cachedSingle && cachedSingle.fetched_at) {
                const fetchedAt = Date.parse(cachedSingle.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                    return { ...cachedSingle.payload, cache: "HIT_DB" };
                }
            }

            const cached = await getCache(CACHE_KEY);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                    const item = Array.isArray(cached.payload?.data)
                        ? cached.payload.data.find((x) => x.symbol === "BBCA")
                        : null;
                    if (item) {
                        return {
                            source: buildCnbcUrl("BBCA"),
                            symbol: item.symbol,
                            name: item.name || null,
                            last: item.last,
                            change: item.change,
                            change_percent: item.change_percent,
                            currency: item.currency || "IDR",
                            fetched_at: cached.fetched_at,
                            cache: "HIT_DB",
                        };
                    }
                }
            }
        } catch (e) {
            console.error("Gagal membaca cache DB CNBC:", e.message);
        }
    }

    if (!bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const payload = await fetchCnbcSingle({ symbol: "BBCA" });
    cache = { at: now, payload };

    try {
        await setCache(CACHE_KEY_BBCA, payload, payload.fetched_at);
    } catch (e) {
        // jangan blok request kalau gagal tulis DB
        console.error("Gagal menulis cache DB CNBC (BBCA):", e.message);
    }
    return { ...payload, cache: "MISS" };
}

async function fetchInvestingMultipleCached({ bypassCache = false } = {}) {
    const now = Date.now();

    if (!bypassCache) {
        try {
            const cached = await getCache(CACHE_KEY);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                    return { ...cached.payload, cache: "HIT_DB" };
                }
            }
        } catch (e) {
            console.error("Gagal membaca cache DB CNBC:", e.message);
        }
    }

    if (!bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const items = [];
    for (const q of QUOTES) {
        items.push(await fetchCnbcSingle({ symbol: q.symbol }));
    }

    const payload = {
        source: QUOTES.map((q) => buildCnbcUrl(q.symbol)),
        count: items.length,
        data: items,
        fetched_at: new Date().toISOString(),
    };

    cache = { at: now, payload };

    try {
        await setCache(CACHE_KEY, payload, payload.fetched_at);
    } catch (e) {
        // jangan blok request kalau gagal tulis file
        console.error("Gagal menulis cache DB CNBC:", e.message);
    }

    return { ...payload, cache: "MISS" };
}

module.exports = { fetchInvestingBcaCached, fetchInvestingMultipleCached };
