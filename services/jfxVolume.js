const axios = require("axios");
const cheerio = require("cheerio");
const { getCache, setCache } = require("./cacheStore");

const JFX_HOME_URL = "https://jfx.co.id/";
const JFX_VOLUME_URL = "https://jfx.co.id/Home/get_grafik_volume";

const CACHE_TTL_MS = Number(process.env.JFX_CACHE_TTL_MS || 10 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.JFX_TIMEOUT_MS || 20000);

const DEFAULT_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
};

let memoryCache = new Map();

function normalizeMonthYear({ month, year }) {
    const monthNumber = Number(month);
    const yearNumber = Number(year);

    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
        const error = new Error("Query `month` harus 1-12.");
        error.detail = { month };
        throw error;
    }

    if (
        !Number.isInteger(yearNumber) ||
        yearNumber < 2000 ||
        yearNumber > 2100
    ) {
        const error = new Error("Query `year` tidak valid.");
        error.detail = { year };
        throw error;
    }

    return { month: monthNumber, year: yearNumber };
}

function buildCacheKey({ month, year }) {
    return `jfx_volume_${year}_${String(month).padStart(2, "0")}`;
}

function parseCsrfFromHomeHtml(html) {
    const $ = cheerio.load(String(html || ""));
    const input = $(".txt_csrfname").first();
    const csrfName = input.attr("name");
    const csrfValue = input.attr("value");

    if (!csrfName || !csrfValue) {
        const error = new Error("Gagal menemukan CSRF token dari halaman JFX.");
        error.detail = { found: Boolean(csrfName), foundValue: Boolean(csrfValue) };
        throw error;
    }

    return { csrfName, csrfValue };
}

function extractCookieHeaderFromSetCookie(setCookieHeader) {
    const cookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader
          ? [setCookieHeader]
          : [];

    return cookies
        .map((c) => String(c).split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
}

async function fetchRemoteVolume({ month, year }) {
    const client = axios.create({
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    const homeRes = await client.get(JFX_HOME_URL, { headers: DEFAULT_HEADERS });
    const cookieHeader = extractCookieHeaderFromSetCookie(homeRes.headers?.["set-cookie"]);
    const { csrfName, csrfValue } = parseCsrfFromHomeHtml(homeRes.data);

    const form = new URLSearchParams({
        bulan: String(month),
        tahun: String(year),
        [csrfName]: csrfValue,
    });

    const volumeRes = await client.post(JFX_VOLUME_URL, form.toString(), {
        headers: {
            ...DEFAULT_HEADERS,
            ...(cookieHeader ? { Cookie: cookieHeader } : null),
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: JFX_HOME_URL,
            Origin: "https://jfx.co.id",
        },
    });

    return volumeRes.data;
}

function normalizeVolumePayload(remotePayload, { month, year }) {
    const raw = remotePayload && typeof remotePayload === "object" ? remotePayload : {};
    const items = Array.isArray(raw.data_grafik) ? raw.data_grafik : [];

    const data = items
        .map((it) => ({
            label: String(it?.label || "").trim(),
            volume: Number(it?.y),
            raw_y: it?.y,
        }))
        .filter((it) => it.label);

    return {
        source: JFX_VOLUME_URL,
        month,
        year,
        fetched_at: new Date().toISOString(),
        token: raw.token || null,
        count: data.length,
        data,
    };
}

async function fetchJfxVolume({ month, year, bypassCache = false } = {}) {
    const normalized = normalizeMonthYear({ month, year });
    const key = buildCacheKey(normalized);
    const now = Date.now();

    if (!bypassCache) {
        const mem = memoryCache.get(key);
        if (mem && now - mem.fetchedAt < CACHE_TTL_MS) {
            return { ...mem.payload, cache: "HIT" };
        }

        try {
            const cached = await getCache(key);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                    const payload = cached.payload || null;
                    if (payload && typeof payload === "object") {
                        memoryCache.set(key, { fetchedAt: now, payload });
                        return { ...payload, cache: "HIT_DB" };
                    }
                }
            }
        } catch (error) {
            console.error("Gagal membaca cache DB JFX:", error.message);
        }
    }

    const remote = await fetchRemoteVolume(normalized);
    const payload = normalizeVolumePayload(remote, normalized);

    memoryCache.set(key, { fetchedAt: now, payload });

    try {
        await setCache(key, payload, payload.fetched_at);
    } catch (error) {
        console.error("Gagal menulis cache DB JFX:", error.message);
    }

    return { ...payload, cache: bypassCache ? "BYPASS" : "MISS" };
}

module.exports = {
    fetchJfxVolume,
};

