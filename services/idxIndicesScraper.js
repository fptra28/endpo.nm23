// services/idxIndicesScraper.js
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
async function getAxiosWrapper() {
    const mod = await import("axios-cookiejar-support");
    return mod.wrapper || mod.default?.wrapper;
}

const IDX_PAGE_URL =
    process.env.IDX_INDICES_PAGE_URL ||
    "https://www.idx.co.id/id/data-pasar/ringkasan-perdagangan/ringkasan-indeks/";

const CACHE_TTL_MS = Number(process.env.IDX_CACHE_TTL_MS || 5 * 60 * 1000);
let cache = { at: 0, payload: null };

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function pick(obj, keys) {
    for (const k of keys) {
        if (obj && obj[k] != null && obj[k] !== "") return obj[k];
    }
    return null;
}

// Ambil semua URL /umbraco/Surface/... dari HTML, lalu cari yang mengandung "Index"
function discoverIndexApiUrl(html) {
    const matches = html.match(/\/umbraco\/Surface\/[A-Za-z0-9/_-]+/g) || [];
    const uniq = [...new Set(matches)];

    // prioritas: yang ada kata Index + Summary
    const preferred =
        uniq.find((u) => /indexsummary/i.test(u)) ||
        uniq.find((u) => /get.*index/i.test(u)) ||
        uniq.find((u) => /index/i.test(u));

    if (!preferred) return null;
    return `https://www.idx.co.id${preferred}`;
}

function normalizeIndexCode(codeOrName) {
    return String(codeOrName || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

function extractItems(json) {
    // IDX kadang pakai: { Items: [...] } atau { data: [...] } atau langsung array
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.Items)) return json.Items;
    if (json && Array.isArray(json.items)) return json.items;
    if (json && Array.isArray(json.data)) return json.data;
    if (json && json.result && Array.isArray(json.result)) return json.result;
    return [];
}

async function fetchIdxIndicesCore() {
    const jar = new CookieJar();
    const wrapper = await getAxiosWrapper();
    if (!wrapper) {
        throw new Error("Gagal memuat axios-cookiejar-support wrapper (ESM import).");
    }
    const client = wrapper(
        axios.create({
            jar,
            withCredentials: true,
            timeout: 20000,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                Connection: "keep-alive",
            },
            validateStatus: (s) => s >= 200 && s < 400,
        })
    );

    // 1) hit page dulu (penting untuk cookie / cf) :contentReference[oaicite:2]{index=2}
    const pageRes = await client.get(IDX_PAGE_URL);
    const html = String(pageRes.data || "");

    // 2) discover API url dari HTML
    const apiUrlFromHtml = discoverIndexApiUrl(html);

    // 3) fallback kandidat endpoint (kalau HTML tidak memuatnya)
    const candidates = [
        apiUrlFromHtml,
        "https://www.idx.co.id/umbraco/Surface/TradingSummary/GetIndexSummary",
        "https://www.idx.co.id/umbraco/Surface/StockData/GetIndexSummary",
        "https://www.idx.co.id/umbraco/Surface/StockData/GetIndex",
        "https://www.idx.co.id/umbraco/Surface/StockData/GetIndexData",
    ].filter(Boolean);

    let lastErr = null;
    let rawJson = null;
    let usedUrl = null;

    for (const url of candidates) {
        try {
            // Banyak endpoint IDX pakai param start/length (mirip GetStockSummary) :contentReference[oaicite:3]{index=3}
            const res = await client.get(url, {
                params: {
                    start: 0,
                    length: 2000,
                    // beberapa endpoint butuh language:
                    language: "id-id",
                },
                headers: {
                    Accept: "application/json, text/plain, */*",
                    Referer: IDX_PAGE_URL,
                },
            });

            rawJson = res.data;
            usedUrl = url;
            break;
        } catch (e) {
            lastErr = e;
            await sleep(300);
        }
    }

    if (!rawJson) {
        throw new Error(
            `Gagal ambil JSON index summary dari IDX. Coba cek akses Cloudflare/endpoint. Last error: ${lastErr?.message || "-"}`
        );
    }

    const items = extractItems(rawJson);

    if (!items.length) {
        throw new Error("IDX JSON didapat, tapi item kosong (struktur response berubah).");
    }

    // Mapping yang fleksibel: cari code/name & angka close
    const mapped = items
        .map((it) => {
            const code =
                pick(it, ["IndexCode", "indexCode", "KodeIndeks", "kodeIndeks", "Code", "code"]) ||
                pick(it, ["IndexName", "indexName", "NamaIndeks", "namaIndeks", "Name", "name"]);

            const name =
                pick(it, ["IndexName", "indexName", "NamaIndeks", "namaIndeks", "Name", "name"]) ||
                code;

            // common fields untuk penutupan/last
            const close =
                pick(it, ["Close", "close", "Last", "last", "Penutupan", "penutupan", "Value", "value"]) ??
                null;

            return { code, name, close, raw: it };
        })
        .filter((x) => x.code);

    // ambil yang diminta user
    const wanted = new Set(["COMPOSITE", "IDX30", "LQ45", "KOMPAS100"]);
    const filtered = mapped.filter((x) => wanted.has(normalizeIndexCode(x.code)));

    if (!filtered.length) {
        // fallback: kadang code-nya bukan COMPOSITE tapi IHSG/IDXCOMPOSITE, kita coba cari by name
        const byName = mapped.filter((x) => {
            const nm = normalizeIndexCode(x.name);
            return (
                nm.includes("KOMPAS100") ||
                nm.includes("IDX30") ||
                nm.includes("LQ45") ||
                nm.includes("COMPOSITE") ||
                nm.includes("IHSG")
            );
        });

        if (!byName.length) {
            throw new Error(
                "Data indeks ada, tapi tidak ketemu COMPOSITE/IDX30/LQ45/KOMPAS100 (mungkin key code beda)."
            );
        }

        return {
            source_page: IDX_PAGE_URL,
            source_api: usedUrl,
            count: byName.length,
            data: byName.map(({ raw, ...rest }) => rest),
            fetched_at: new Date().toISOString(),
        };
    }

    return {
        source_page: IDX_PAGE_URL,
        source_api: usedUrl,
        count: filtered.length,
        data: filtered.map(({ raw, ...rest }) => rest),
        fetched_at: new Date().toISOString(),
    };
}

async function fetchIdxIndicesCached() {
    const now = Date.now();
    if (cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const payload = await fetchIdxIndicesCore();
    cache = { at: now, payload };
    return { ...payload, cache: "MISS" };
}

module.exports = { fetchIdxIndicesCached };
