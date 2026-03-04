// services/kontanIndicesScraper.js
const axios = require("axios");
const cheerio = require("cheerio");

const KONTAN_URL =
    process.env.KONTAN_URL || "https://www.kontan.co.id/indeks-idx30";

// cache (disarankan biar gak spam)
const CACHE_TTL_MS = Number(process.env.KONTAN_CACHE_TTL_MS || 5 * 60 * 1000);
let cache = { at: 0, payload: null };

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// angka Indonesia: 7.452,33 -> 7452.33
function parseIdNumber(text) {
    if (!text) return null;
    const cleaned = String(text)
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\./g, "")
        .replace(",", ".");
    const m = cleaned.match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

async function getHtmlWithRetry(url, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await axios.get(url, {
                timeout: 20000,
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
            await sleep(400 * i);
            if (i === tries) throw lastErr;
        }
    }
}

// ambil nilai indeks via regex dari pageText
function extractIndexValue(pageText, labelPatterns) {
    for (const pat of labelPatterns) {
        // 1) mode ketat: label diikuti angka (indikator list)
        const strictRe = new RegExp(
            `${pat}\\s+(-?\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?)`,
            "i"
        );
        let m = pageText.match(strictRe);
        if (m) {
            const v = parseIdNumber(m[1]);
            if (v != null) return v;
        }

        // 2) fallback: label lalu angka terdekat
        const looseRe = new RegExp(
            `${pat}[^0-9]{0,80}(-?\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?)`,
            "i"
        );
        m = pageText.match(looseRe);
        if (m) {
            const v = parseIdNumber(m[1]);
            if (v != null) return v;
        }
    }
    return null;
}

function extractIndicatorBlock(pageText, labelPatterns) {
    for (const pat of labelPatterns) {
        const re = new RegExp(
            `${pat}\\s+(-?\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?)\\s+(-?\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?)\\s+(-?\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?%)`,
            "i"
        );
        const m = pageText.match(re);
        if (m) {
            const last = parseIdNumber(m[1]);
            const change = parseIdNumber(m[2]);
            const changePercent = parseIdNumber(String(m[3]).replace("%", ""));
            let direction = "flat";
            if (change != null) {
                if (change > 0) direction = "up";
                else if (change < 0) direction = "down";
            }
            return {
                last,
                change,
                change_percent: changePercent,
                direction,
            };
        }
    }
    return null;
}

function scrapeKontanIndicesFromHtml(html) {
    const $ = cheerio.load(html);

    // gabungkan text (lebih gampang dan fleksibel)
    const pageText = $.text().replace(/\s+/g, " ");

    const composite = extractIndicatorBlock(pageText, [
        "\\bIDX\\b",
        "\\bIHSG\\b",
        "IDX\\s*COMPOSITE",
        "JAKARTA\\s*COMPOSITE",
        "INDEKS\\s*HARGA\\s*SAHAM\\s*GABUNGAN",
    ]);

    const idx30 = extractIndicatorBlock(pageText, ["\\bIDX\\s*30\\b", "\\bIDX30\\b"]);
    const lq45 = extractIndicatorBlock(pageText, ["\\bLQ\\s*45\\b", "\\bLQ45\\b"]);
    const kompas100 = extractIndicatorBlock(pageText, ["\\bKOMPAS\\s*100\\b", "\\bKOMPAS100\\b"]);

    // minimal harus ketemu beberapa
    const foundCount = [composite, idx30, lq45, kompas100].filter((x) => x && x.last != null).length;

    if (foundCount < 2) {
        // kalau kurang dari 2, kemungkinan struktur berubah / halaman beda
        throw new Error(
            "Gagal menemukan cukup data indeks dari Kontan (mungkin struktur halaman berubah)."
        );
    }

    return {
        source: KONTAN_URL,
        indices: {
            composite,
            idx30,
            lq45,
            kompas100,
        },
        fetched_at: new Date().toISOString(),
    };
}

async function fetchKontanIndicesCached() {
    const now = Date.now();
    if (cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const html = await getHtmlWithRetry(KONTAN_URL, 3);
    const payload = scrapeKontanIndicesFromHtml(html);

    cache = { at: now, payload };
    return { ...payload, cache: "MISS" };
}

// Backward-compatible alias for routes expecting fetchIdxIndicesCached
async function fetchIdxIndicesCached() {
    return fetchKontanIndicesCached();
}

module.exports = { fetchIdxIndicesCached };
