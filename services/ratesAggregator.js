const fs = require("fs");
const path = require("path");
const { fetchBiRate } = require("./scraper");
const { getCache, setCache } = require("./cacheStore");
const {
    fetchUsInterestRateCached,
    fetchJapanInterestRateCached,
    fetchHongKongInterestRateCached,
} = require("./usInterestRateScraper");

const SOURCE_TIMEOUT_MS = Number(process.env.RATES_SOURCE_TIMEOUT_MS || 25000);
const CACHE_TTL_MS = Number(process.env.RATES_CACHE_TTL_MS || 60 * 1000);
const CACHE_KEY = "rates_all";
const BI_RATE_FALLBACK_PATH = path.join(__dirname, "..", "data", "bi_rate.json");
let cache = { at: 0, payload: null };

function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function withTimeout(promise, label, timeoutMs = SOURCE_TIMEOUT_MS) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`${label} timeout setelah ${timeoutMs}ms`));
            }, timeoutMs);
        }),
    ]);
}

function loadBiRateFallback() {
    const raw = fs.readFileSync(BI_RATE_FALLBACK_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
        ...parsed,
        cache: "LOCAL_FALLBACK",
    };
}

function sortByDateDesc(items) {
    return [...items].sort((a, b) => {
        const ad = isIsoDate(a?.date) ? a.date : "";
        const bd = isIsoDate(b?.date) ? b.date : "";
        if (ad === bd) return 0;
        return ad < bd ? 1 : -1;
    });
}

function buildRatePayload({
    key,
    label,
    country,
    source,
    cache,
    fetched_at,
    rate,
    previous_rate,
    unit = null,
    date = null,
    previous_date = null,
    reference_period = null,
    source_last_update = null,
    press_release_url = null,
}) {
    return {
        key,
        label,
        country,
        source: source || null,
        cache: cache || null,
        fetched_at: fetched_at || null,
        rate: rate ?? null,
        previous_rate: previous_rate ?? null,
        unit,
        date,
        previous_date,
        reference_period,
        source_last_update,
        press_release_url,
    };
}

function mapBiRate(data) {
    const items = Array.isArray(data?.data) ? sortByDateDesc(data.data) : [];
    const latest = items[0] || null;
    const previous = items[1] || null;

    return buildRatePayload({
        key: "bi_rate",
        label: "BI-Rate",
        country: "Indonesia",
        source: data?.source,
        cache: data?.cache,
        fetched_at: data?.fetched_at,
        rate: latest?.rate,
        previous_rate: previous?.rate,
        unit: "Persen",
        date: latest?.date || null,
        previous_date: previous?.date || null,
        press_release_url: latest?.press_release_url || null,
    });
}

function mapTradingEconomicsRate({
    key,
    label,
    country,
    data,
}) {
    return buildRatePayload({
        key,
        label,
        country,
        source: data?.source,
        cache: data?.cache,
        fetched_at: data?.fetched_at,
        rate: data?.rate,
        previous_rate: data?.previous_rate,
        unit: data?.unit || null,
        reference_period: data?.reference_period || null,
        source_last_update: data?.source_last_update || null,
    });
}

async function fetchBiRateWithFallback() {
    try {
        return await withTimeout(fetchBiRate(), "BI rate");
    } catch (error) {
        const fallback = loadBiRateFallback();
        fallback.fallback_reason = error.message;
        return fallback;
    }
}

async function fetchAllRates({ bypassCache = false } = {}) {
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
        } catch (error) {
            console.error("Gagal membaca cache DB rates:", error.message);
        }

        if (cache.payload && now - cache.at < CACHE_TTL_MS) {
            return { ...cache.payload, cache: "HIT" };
        }
    }

    const [biResult, usResult, japanResult, hongKongResult] = await Promise.allSettled([
        fetchBiRateWithFallback(),
        withTimeout(fetchUsInterestRateCached({ bypassCache }), "US interest rate"),
        withTimeout(fetchJapanInterestRateCached({ bypassCache }), "Japan interest rate"),
        withTimeout(
            fetchHongKongInterestRateCached({ bypassCache }),
            "Hong Kong interest rate"
        ),
    ]);

    const data = {};
    const errors = [];

    if (biResult.status === "fulfilled") {
        data.bi_rate = mapBiRate(biResult.value);
        if (biResult.value?.fallback_reason) {
            errors.push({
                key: "bi_rate",
                message: biResult.value.fallback_reason,
                fallback: "data/bi_rate.json",
            });
        }
    } else {
        errors.push({
            key: "bi_rate",
            message: biResult.reason?.message || "Unknown error",
        });
    }

    if (usResult.status === "fulfilled") {
        data.us_interest_rate = mapTradingEconomicsRate({
            key: "us_interest_rate",
            label: "Fed Funds Rate",
            country: "United States",
            data: usResult.value,
        });
    } else {
        errors.push({
            key: "us_interest_rate",
            message: usResult.reason?.message || "Unknown error",
        });
    }

    if (japanResult.status === "fulfilled") {
        data.japan_interest_rate = mapTradingEconomicsRate({
            key: "japan_interest_rate",
            label: "Japan Interest Rate",
            country: "Japan",
            data: japanResult.value,
        });
    } else {
        errors.push({
            key: "japan_interest_rate",
            message: japanResult.reason?.message || "Unknown error",
        });
    }

    if (hongKongResult.status === "fulfilled") {
        data.hong_kong_interest_rate = mapTradingEconomicsRate({
            key: "hong_kong_interest_rate",
            label: "Hong Kong Interest Rate",
            country: "Hong Kong",
            data: hongKongResult.value,
        });
    } else {
        errors.push({
            key: "hong_kong_interest_rate",
            message: hongKongResult.reason?.message || "Unknown error",
        });
    }

    if (!Object.keys(data).length) {
        const error = new Error("Semua sumber rate gagal diambil.");
        error.detail = errors;
        throw error;
    }

    const payload = {
        fetched_at: new Date().toISOString(),
        count: Object.keys(data).length,
        data,
        errors,
    };

    cache = { at: now, payload };

    try {
        await setCache(CACHE_KEY, payload, payload.fetched_at);
    } catch (error) {
        console.error("Gagal menulis cache DB rates:", error.message);
    }

    return { ...payload, cache: bypassCache ? "BYPASS" : "MISS" };
}

module.exports = {
    fetchAllRates,
};
