// services/scraper.js

const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const { getCache, setCache } = require("./cacheStore");
const { parseIndoDate, normalizeUrl } = require("../utils/text");

const BI_RATE_URL_ID =
    process.env.BI_RATE_URL ||
    "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx";

const BI_RATE_URL_EN = "https://www.bi.go.id/en/statistik/indikator/bi-rate.aspx";

// cache biar ga spam BI
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
let cache = { fetchedAt: 0, payload: null };
const CACHE_KEY = "bi_rate";

// keep-alive agent biar koneksi stabil
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

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
                    Accept:
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                },
                timeout: 20000,
                httpAgent,
                httpsAgent,
                // BI kadang pakai kompresi; axios handle tapi ini bantu di beberapa host
                decompress: true,
                maxRedirects: 5,
                validateStatus: (s) => s >= 200 && s < 400,
            });

            return res.data;
        } catch (err) {
            lastErr = err;

            // backoff biar ga dianggap spam
            await sleep(500 * i);

            // kalau sudah percobaan terakhir, lempar error
            if (i === tries) throw lastErr;
        }
    }
}

function scrapeFromHtml(html, { preferIndoDate = true } = {}) {
    const $ = cheerio.load(html);

    // Cari tabel yang mengandung header BI-Rate + Tanggal/Period
    let table = $("table")
        .filter((_, el) => {
            const text = $(el).text();
            return (
                text.includes("BI-Rate") &&
                (text.includes("Tanggal") || text.includes("Period"))
            );
        })
        .first();

    if (!table.length) {
        // fallback: ambil table pertama kalau BI ubah struktur
        table = $("table").first();
    }

    let rows = table.find("tbody tr");
    if (!rows.length) rows = table.find("tr").slice(1);

    const items = [];
    rows.each((_, row) => {
        // BI kadang punya TH di dalam row, jadi ambil td + th
        const cells = $(row).find("td, th");
        if (cells.length < 3) return;

        // Ambil teks tiap kolom
        const c0 = cells.eq(0).text().trim(); // No
        const c1 = cells.eq(1).text().trim(); // Tanggal
        const c2 = cells.eq(2).text().trim(); // BI-Rate

        // Link: cari anchor "Lihat" dalam row (bukan tergantung eq(3))
        const a = $(row).find("a").first();
        const linkHref = a && a.attr("href") ? a.attr("href") : null;
        const link = normalizeUrl(linkHref);

        // Guard: pastikan c2 itu beneran rate (mengandung % / angka)
        const looksLikeRate = /%/.test(c2) || /\d/.test(c2);
        const looksLikeDate = /\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4}/.test(c1) || /\d{1,2}\s+\w+\s+\d{4}/.test(c1);

        if (!looksLikeRate || !looksLikeDate) return;

        const isoDate = parseIndoDate(c1);
        const rate = Number(c2.replace("%", "").replace(",", ".").trim());

        items.push({
            date: isoDate || c1,
            rate: Number.isFinite(rate) ? rate : c2,
            press_release_url: link,
            raw_date: c1,
            raw_rate: c2,
        });
    });

    if (!items.length) {
        throw new Error("Tidak ada data BI-Rate yang terbaca dari tabel.");
    }

    return items;
}

async function fetchBiRate({ from, to } = {}) {
    // cache HIT
    const now = Date.now();
    try {
        const cached = await getCache(CACHE_KEY);
        if (cached && cached.fetched_at) {
            const fetchedAt = Date.parse(cached.fetched_at);
            if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                const filtered = filterByDate(cached.payload?.data || [], { from, to });
                return {
                    source: cached.payload?.source,
                    count: filtered.length,
                    data: filtered,
                    fetched_at: cached.fetched_at,
                    cache: "HIT_DB",
                };
            }
        }
    } catch (e) {
        console.error("Gagal membaca cache DB BI Rate:", e.message);
    }
    if (cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
        const filtered = filterByDate(cache.payload.data, { from, to });
        return {
            ...cache.payload,
            count: filtered.length,
            data: filtered,
            cache: "HIT",
        };
    }

    // 1) coba halaman ID dulu
    let html, source;
    try {
        html = await axiosGetWithRetry(BI_RATE_URL_ID, 3);
        source = BI_RATE_URL_ID;
        const items = scrapeFromHtml(html, { preferIndoDate: true });
        const filtered = filterByDate(items, { from, to });

        const payload = {
            source,
            count: filtered.length,
            data: filtered,
            fetched_at: new Date().toISOString(),
        };

        cache = { fetchedAt: now, payload: { source, data: items, fetched_at: payload.fetched_at } };

        try {
            await setCache(CACHE_KEY, payload, payload.fetched_at);
        } catch (e) {
            console.error("Gagal menulis cache DB BI Rate:", e.message);
        }

        return { ...payload, cache: "MISS" };
    } catch (e) {
        // 2) fallback ke halaman EN (kadang ID nge-reset)
        try {
            html = await axiosGetWithRetry(BI_RATE_URL_EN, 3);
            source = BI_RATE_URL_EN;

            const items = scrapeFromHtml(html, { preferIndoDate: false });
            const normalized = normalizeEnDates(items); // ubah "19 February 2026" -> "2026-02-19" kalau bisa
            const filtered = filterByDate(normalized, { from, to });

            const payload = {
                source,
                count: filtered.length,
                data: filtered,
                fetched_at: new Date().toISOString(),
            };

            cache = { fetchedAt: now, payload: { source, data: normalized, fetched_at: payload.fetched_at } };

            try {
                await setCache(CACHE_KEY, payload, payload.fetched_at);
            } catch (e) {
                console.error("Gagal menulis cache DB BI Rate:", e.message);
            }

            return { ...payload, cache: "MISS_FALLBACK_EN" };
        } catch (e2) {
            // lempar yang lebih informatif
            const msg = e2.message || e.message || "Unknown error";
            const err = new Error(msg);
            err.original = { id: e.message, en: e2.message };
            throw err;
        }
    }
}

function filterByDate(items, { from, to }) {
    return items.filter((item) => {
        // kalau date belum ISO, skip filter
        if (!item.date || item.date.length !== 10) return true;
        if (from && item.date < from) return false;
        if (to && item.date > to) return false;
        return true;
    });
}

// convert EN month names to ISO if possible
function normalizeEnDates(items) {
    const months = {
        january: "01",
        february: "02",
        march: "03",
        april: "04",
        may: "05",
        june: "06",
        july: "07",
        august: "08",
        september: "09",
        october: "10",
        november: "11",
        december: "12",
    };

    return items.map((it) => {
        const t = (it.raw_date || it.date || "").replace(/\s+/g, " ").trim();
        // "19 February 2026"
        const m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
        if (!m) return it;

        const day = m[1].padStart(2, "0");
        const mon = months[m[2].toLowerCase()];
        const year = m[3];

        if (!mon) return it;
        return { ...it, date: `${year}-${mon}-${day}` };
    });
}

module.exports = {
    fetchBiRate,
};
