// services/pricechartingScraper.js
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const { getCache, setCache } = require("./cacheStore");

const BASE_URL =
    "https://www.pricecharting.com/console/pokemon-ascended-heroes?exclude-hardware=false&exclude-variants=false&in-collection=&model-number=&model-number=&show-images=true&sort=model-number&view=table";

const CACHE_TTL_MS = Number(process.env.PRICECHARTING_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const CACHE_KEY = "pricecharting_pokemon_ascended_heroes";

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

let cache = { at: 0, payload: null };

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
            await sleep(400 * i);
        }
    }
}

function parseUsdPrice(input) {
    if (!input) return null;
    const raw = String(input).trim();
    if (!raw) return null;
    const cleaned = raw.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
}

function scrapePricecharting(html) {
    const $ = cheerio.load(html);
    const rows = $("#games_table tbody tr");

    if (!rows.length) {
        throw new Error("Tabel games_table tidak ditemukan. Struktur halaman berubah.");
    }

    const items = [];
    rows.each((_, row) => {
        const $row = $(row);
        const name = $row.find("td.title a").first().text().trim();
        const image = $row.find("td.image img.photo").attr("src") || null;
        const productUrl = $row.find("td.title a").first().attr("href") || null;

        const ungradedRaw = $row.find("td.used_price .js-price").first().text().trim();
        const grade9Raw = $row.find("td.cib_price .js-price").first().text().trim();
        const psa10Raw = $row.find("td.new_price .js-price").first().text().trim();

        if (!name) return;

        items.push({
            name,
            image,
            product_url: productUrl ? new URL(productUrl, "https://www.pricecharting.com").toString() : null,
            price_ungraded: parseUsdPrice(ungradedRaw),
            price_grade_9: parseUsdPrice(grade9Raw),
            price_psa_10: parseUsdPrice(psa10Raw),
            currency: "USD",
            raw: {
                ungraded: ungradedRaw || null,
                grade_9: grade9Raw || null,
                psa_10: psa10Raw || null,
            },
        });
    });

    if (!items.length) {
        throw new Error("Tidak ada item yang terbaca dari tabel.");
    }

    return items;
}

async function fetchPricechartingAscendedHeroes({ bypassCache = false } = {}) {
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
            console.error("Gagal membaca cache DB PriceCharting:", e.message);
        }
    }

    if (!bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const html = await axiosGetWithRetry(BASE_URL, 3);
    const items = scrapePricecharting(html);

    const payload = {
        source: BASE_URL,
        count: items.length,
        data: items,
        fetched_at: new Date().toISOString(),
    };

    cache = { at: now, payload };

    try {
        await setCache(CACHE_KEY, payload, payload.fetched_at);
    } catch (e) {
        console.error("Gagal menulis cache DB PriceCharting:", e.message);
    }

    return { ...payload, cache: "MISS" };
}

module.exports = { fetchPricechartingAscendedHeroes };
