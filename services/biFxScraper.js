// services/biFxScraper.js
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const { parseIdNumber } = require("../utils/number");

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const BI_FX_URL =
    process.env.BI_FX_URL ||
    "https://www.bi.go.id/id/statistik/informasi-kurs/transaksi-bi/default.aspx"; // :contentReference[oaicite:3]{index=3}

const CACHE_TTL_MS = Number(process.env.BI_CACHE_TTL_MS || 5 * 60 * 1000); // 5 menit
let cache = { at: 0, payload: null };

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function getHtmlWithRetry(url, tries = 3) {
    let lastErr;

    for (let i = 1; i <= tries; i++) {
        try {
            const res = await axios.get(url, {
                timeout: 20000,
                httpAgent,
                httpsAgent,
                maxRedirects: 5,
                decompress: true,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
                    Accept:
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                },
                validateStatus: (s) => s >= 200 && s < 400,
            });

            return res.data;
        } catch (e) {
            lastErr = e;
            await sleep(500 * i);
            if (i === tries) throw lastErr;
        }
    }
}

function findFxTable($) {
    // tabel yang punya header "Mata Uang" + "Kurs Jual" + "Kurs Beli"
    let table = null;

    $("table").each((_, el) => {
        const header = $(el).find("thead").text().replace(/\s+/g, " ").toLowerCase();
        const all = $(el).text().replace(/\s+/g, " ").toLowerCase();

        const ok =
            (header.includes("mata uang") || all.includes("mata uang")) &&
            (header.includes("kurs jual") || all.includes("kurs jual")) &&
            (header.includes("kurs beli") || all.includes("kurs beli"));

        if (ok) {
            table = el;
            return false;
        }
    });

    if (!table) table = $("table").first().get(0);
    return table ? $(table) : null;
}

function parseBiFxFromHtml(html) {
    const $ = cheerio.load(html);

    const table = findFxTable($);
    if (!table || !table.length) {
        throw new Error("Tabel Kurs Transaksi BI tidak ditemukan (struktur berubah).");
    }

    let rows = table.find("tbody tr");
    if (!rows.length) rows = table.find("tr").slice(1);

    const data = [];

    rows.each((_, tr) => {
        const tds = $(tr).find("td");
        // Umumnya: Mata Uang | Nilai | Kurs Jual | Kurs Beli | Grafik
        if (tds.length < 4) return;

        const currency = tds.eq(0).text().trim(); // AED, USD, JPY, dll
        const unit = parseIdNumber(tds.eq(1).text()); // 1 atau 100 (JPY)
        const sell = parseIdNumber(tds.eq(2).text());
        const buy = parseIdNumber(tds.eq(3).text());

        if (!currency) return;
        if (sell == null || buy == null) return;

        data.push({
            currency,
            unit: unit ?? 1,
            sell,
            buy,
        });
    });

    if (!data.length) {
        throw new Error("Tidak ada data kurs BI yang kebaca.");
    }

    return {
        source: BI_FX_URL,
        count: data.length,
        data,
        fetched_at: new Date().toISOString(),
    };
}

async function fetchBiFxCached() {
    const now = Date.now();
    if (cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const html = await getHtmlWithRetry(BI_FX_URL, 3);
    const payload = parseBiFxFromHtml(html);

    cache = { at: now, payload };
    return { ...payload, cache: "MISS" };
}

module.exports = {
    fetchBiFxCached,
};