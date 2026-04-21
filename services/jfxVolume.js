const axios = require("axios");
const cheerio = require("cheerio");
const { getCache, setCache } = require("./cacheStore");

const JFX_HOME_URL = "https://jfx.co.id/";
const JFX_VOLUME_URL = "https://jfx.co.id/Home/get_grafik_volume";

// Cache behavior:
// - Past months: data is effectively immutable, cache for a long time.
// - Current (or future) month: refresh at most once per day (default).
// You can override all of this via JFX_CACHE_TTL_MS.
const GLOBAL_CACHE_TTL_MS = process.env.JFX_CACHE_TTL_MS
    ? Number(process.env.JFX_CACHE_TTL_MS)
    : null;
const CURRENT_CACHE_TTL_MS = Number(
    process.env.JFX_CURRENT_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
const PAST_CACHE_TTL_MS = Number(
    process.env.JFX_PAST_CACHE_TTL_MS || 365 * 24 * 60 * 60 * 1000
);
const META_CACHE_TTL_MS = Number(
    process.env.JFX_META_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
const REQUEST_TIMEOUT_MS = Number(process.env.JFX_TIMEOUT_MS || 20000);
const MAX_MONTHS_RANGE = Number(process.env.JFX_MAX_MONTHS_RANGE || 24);

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
let metaCache = { fetchedAt: 0, payload: null };
const META_CACHE_KEY = "jfx_volume_meta";

function getJakartaDateString(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

function getJakartaMonthYearNow() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
    }).formatToParts(new Date());

    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value);
    return { year, month };
}

function getPayloadFetchedAtMs(payload, fallbackMs = Date.now()) {
    const iso = payload && typeof payload === "object" ? payload.fetched_at : null;
    const ms = Date.parse(String(iso || ""));
    return Number.isFinite(ms) ? ms : fallbackMs;
}

function isSameJakartaDay(a, b) {
    const da = a instanceof Date ? a : new Date(a);
    const db = b instanceof Date ? b : new Date(b);
    if (!Number.isFinite(da.getTime()) || !Number.isFinite(db.getTime())) return false;
    return getJakartaDateString(da) === getJakartaDateString(db);
}

function getCacheTtlMsForMonthYear({ month, year }) {
    if (
        typeof process.env.JFX_CACHE_TTL_MS === "string" &&
        process.env.JFX_CACHE_TTL_MS.length > 0 &&
        Number.isFinite(GLOBAL_CACHE_TTL_MS) &&
        GLOBAL_CACHE_TTL_MS >= 0
    ) {
        return GLOBAL_CACHE_TTL_MS;
    }

    const now = getJakartaMonthYearNow();
    const requestIndex = year * 12 + (month - 1);
    const currentIndex = now.year * 12 + (now.month - 1);

    // If requested month is already in the past, treat as stable/immutable.
    if (requestIndex < currentIndex) return PAST_CACHE_TTL_MS;

    // Current (or future) month: refresh daily by default.
    return CURRENT_CACHE_TTL_MS;
}

function requiresDailyRefresh({ month, year }) {
    const now = getJakartaMonthYearNow();
    const requestIndex = year * 12 + (month - 1);
    const currentIndex = now.year * 12 + (now.month - 1);
    return requestIndex >= currentIndex;
}

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

function parseFiltersFromHomeHtml(html) {
    const $ = cheerio.load(String(html || ""));

    const months = [];
    $("#s_volume_b option").each((_, el) => {
        const value = $(el).attr("value");
        const label = $(el).text();
        if (!value) return;
        const month = Number(value);
        if (Number.isInteger(month) && month >= 1 && month <= 12) {
            months.push({ month, label: String(label || "").trim() });
        }
    });

    const years = [];
    $("#s_volume_y option").each((_, el) => {
        const value = $(el).attr("value");
        if (!value) return;
        const year = Number(value);
        if (Number.isInteger(year)) years.push(year);
    });

    return {
        months: months.length ? months : null,
        years: years.length ? years : null,
    };
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

async function createJfxSession() {
    const client = axios.create({
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    const homeRes = await client.get(JFX_HOME_URL, { headers: DEFAULT_HEADERS });
    const cookieHeader = extractCookieHeaderFromSetCookie(homeRes.headers?.["set-cookie"]);
    const { csrfName, csrfValue } = parseCsrfFromHomeHtml(homeRes.data);

    return {
        client,
        cookieHeader,
        csrfName,
        csrfValue,
        homeHtml: homeRes.data,
    };
}

async function fetchRemoteVolumeWithSession(session, { month, year }) {
    const form = new URLSearchParams({
        bulan: String(month),
        tahun: String(year),
        [session.csrfName]: session.csrfValue,
    });

    const volumeRes = await session.client.post(JFX_VOLUME_URL, form.toString(), {
        headers: {
            ...DEFAULT_HEADERS,
            ...(session.cookieHeader ? { Cookie: session.cookieHeader } : null),
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: JFX_HOME_URL,
            Origin: "https://jfx.co.id",
        },
    });

    const payload = volumeRes.data;
    if (payload && typeof payload === "object" && payload.token) {
        session.csrfValue = payload.token;
    }
    return payload;
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

function asStalePayload(payload, fetchedAtMs, cacheTag) {
    const safe = payload && typeof payload === "object" ? payload : null;
    if (!safe) return null;

    const staleFetchedAt =
        safe.fetched_at ||
        (Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null);

    return {
        ...safe,
        fetched_at: staleFetchedAt,
        cache: cacheTag,
        stale: true,
    };
}

function listMonthPairsInRange({ from, to }) {
    const matchFrom = String(from || "").match(/^(\d{4})-(\d{2})$/);
    const matchTo = String(to || "").match(/^(\d{4})-(\d{2})$/);
    if (!matchFrom || !matchTo) {
        const error = new Error("Format `from/to` harus YYYY-MM (contoh 2025-01).");
        error.detail = { from, to };
        throw error;
    }

    const fromYear = Number(matchFrom[1]);
    const fromMonth = Number(matchFrom[2]);
    const toYear = Number(matchTo[1]);
    const toMonth = Number(matchTo[2]);

    const start = normalizeMonthYear({ month: fromMonth, year: fromYear });
    const end = normalizeMonthYear({ month: toMonth, year: toYear });

    const startIndex = start.year * 12 + (start.month - 1);
    const endIndex = end.year * 12 + (end.month - 1);
    if (endIndex < startIndex) {
        const error = new Error("Range tidak valid: `to` harus >= `from`.");
        error.detail = { from, to };
        throw error;
    }

    const count = endIndex - startIndex + 1;
    return { startIndex, count };
}

async function fetchJfxVolume({ month, year, bypassCache = false } = {}) {
    const normalized = normalizeMonthYear({ month, year });
    const key = buildCacheKey(normalized);
    const now = Date.now();
    const ttlMs = getCacheTtlMsForMonthYear(normalized);
    const daily = requiresDailyRefresh(normalized);

    let staleCandidate = null;

    if (!bypassCache) {
        const mem = memoryCache.get(key);
        if (mem && mem.payload && typeof mem.payload === "object") {
            const payloadFetchedAtMs = getPayloadFetchedAtMs(mem.payload, mem.fetchedAt);
            const ttlOk = now - payloadFetchedAtMs < ttlMs;
            const dailyOk = !daily || isSameJakartaDay(payloadFetchedAtMs, now);
            if (ttlOk && dailyOk) return { ...mem.payload, cache: "HIT" };
            staleCandidate = asStalePayload(mem.payload, payloadFetchedAtMs, "STALE_MEM");
        }

        try {
            const cached = await getCache(key);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs) {
                    const payload = cached.payload || null;
                    if (payload && typeof payload === "object") {
                        const dailyOk = !daily || isSameJakartaDay(fetchedAt, now);
                        if (dailyOk) {
                            memoryCache.set(key, { fetchedAt, payload });
                            return { ...payload, cache: "HIT_DB" };
                        }
                    }
                }

                const payload = cached.payload || null;
                if (payload && typeof payload === "object" && !staleCandidate) {
                    staleCandidate = asStalePayload(payload, fetchedAt, "STALE_DB");
                }
            }
        } catch (error) {
            console.error("Gagal membaca cache DB JFX:", error.message);
        }
    }

    let payload;

    try {
        const session = await createJfxSession();
        const remote = await fetchRemoteVolumeWithSession(session, normalized);
        payload = normalizeVolumePayload(remote, normalized);
    } catch (error) {
        if (staleCandidate) {
            return {
                ...staleCandidate,
                error: "Gagal refresh data volume (mengembalikan cache lama)",
                detail: error?.detail || null,
            };
        }
        throw error;
    }

    memoryCache.set(key, { fetchedAt: getPayloadFetchedAtMs(payload, now), payload });

    try {
        await setCache(key, payload, payload.fetched_at);
    } catch (error) {
        console.error("Gagal menulis cache DB JFX:", error.message);
    }

    return { ...payload, cache: bypassCache ? "BYPASS" : "MISS" };
}

async function fetchJfxVolumeMeta({ bypassCache = false } = {}) {
    const now = Date.now();
    if (!bypassCache && metaCache.payload && now - metaCache.fetchedAt < META_CACHE_TTL_MS) {
        return { ...metaCache.payload, cache: "HIT" };
    }

    if (!bypassCache) {
        try {
            const cached = await getCache(META_CACHE_KEY);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < META_CACHE_TTL_MS) {
                    const payload = cached.payload || null;
                    if (payload && typeof payload === "object") {
                        metaCache = { fetchedAt, payload };
                        return { ...payload, cache: "HIT_DB" };
                    }
                }
            }
        } catch (error) {
            console.error("Gagal membaca cache DB JFX meta:", error.message);
        }
    }

    const session = await createJfxSession();
    const filters = parseFiltersFromHomeHtml(session.homeHtml);

    const payload = {
        source: JFX_HOME_URL,
        fetched_at: new Date().toISOString(),
        months: filters.months,
        years: filters.years,
    };

    metaCache = { fetchedAt: now, payload };

    try {
        await setCache(META_CACHE_KEY, payload, payload.fetched_at);
    } catch (error) {
        console.error("Gagal menulis cache DB JFX meta:", error.message);
    }

    return { ...payload, cache: bypassCache ? "BYPASS" : "MISS" };
}

async function fetchJfxVolumeRange({ from, to, bypassCache = false, force = false } = {}) {
    const { startIndex, count } = listMonthPairsInRange({ from, to });

    if (!force && count > MAX_MONTHS_RANGE) {
        const error = new Error(
            `Range terlalu besar (${count} bulan). Max default ${MAX_MONTHS_RANGE} bulan. Tambahkan force=1 kalau mau lanjut.`
        );
        error.detail = { from, to, count, max: MAX_MONTHS_RANGE };
        throw error;
    }

    // Batch fetch with a single session (token updated per request)
    const session = await createJfxSession();
    const results = [];

    for (let i = 0; i < count; i++) {
        const idx = startIndex + i;
        const year = Math.floor(idx / 12);
        const month = (idx % 12) + 1;

        const key = buildCacheKey({ month, year });
        const now = Date.now();
        const ttlMs = getCacheTtlMsForMonthYear({ month, year });
        const daily = requiresDailyRefresh({ month, year });

        if (!bypassCache) {
            const mem = memoryCache.get(key);
            if (mem && mem.payload && typeof mem.payload === "object") {
                const payloadFetchedAtMs = getPayloadFetchedAtMs(mem.payload, mem.fetchedAt);
                const ttlOk = now - payloadFetchedAtMs < ttlMs;
                const dailyOk = !daily || isSameJakartaDay(payloadFetchedAtMs, now);
                if (ttlOk && dailyOk) {
                    results.push({ ...mem.payload, cache: "HIT" });
                    continue;
                }
            }

            try {
                const cached = await getCache(key);
                if (cached && cached.fetched_at) {
                    const fetchedAt = Date.parse(cached.fetched_at);
                    if (Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs) {
                        const payload = cached.payload || null;
                        if (payload && typeof payload === "object") {
                            const dailyOk = !daily || isSameJakartaDay(fetchedAt, now);
                            if (dailyOk) {
                                memoryCache.set(key, { fetchedAt, payload });
                                results.push({ ...payload, cache: "HIT_DB" });
                                continue;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error("Gagal membaca cache DB JFX:", error.message);
            }
        }

        try {
            const remote = await fetchRemoteVolumeWithSession(session, { month, year });
            const payload = normalizeVolumePayload(remote, { month, year });
            memoryCache.set(key, { fetchedAt: getPayloadFetchedAtMs(payload, now), payload });
            try {
                await setCache(key, payload, payload.fetched_at);
            } catch (error) {
                console.error("Gagal menulis cache DB JFX:", error.message);
            }
            results.push({ ...payload, cache: bypassCache ? "BYPASS" : "MISS" });
        } catch (error) {
            results.push({
                source: JFX_VOLUME_URL,
                month,
                year,
                fetched_at: new Date().toISOString(),
                error: error.message,
                detail: error.detail || null,
            });
        }
    }

    return {
        source: JFX_VOLUME_URL,
        from,
        to,
        count: results.length,
        fetched_at: new Date().toISOString(),
        data: results,
    };
}

module.exports = {
    fetchJfxVolume,
    fetchJfxVolumeMeta,
    fetchJfxVolumeRange,
};
