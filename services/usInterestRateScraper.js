const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const { getCache, setCache } = require("./cacheStore");

const CACHE_TTL_MS = Number(
    process.env.US_INTEREST_RATE_CACHE_TTL_MS || 60 * 60 * 1000
);

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const memoryCache = new Map();

const TE_INTEREST_RATE_CONFIGS = {
    us: {
        cacheKey: "us_interest_rate_te",
        url:
            process.env.US_INTEREST_RATE_URL ||
            "https://id.tradingeconomics.com/united-states/interest-rate",
        fallbackTitle: "Suku Bunga Amerika",
    },
    japan: {
        cacheKey: "japan_interest_rate_te",
        url:
            process.env.JAPAN_INTEREST_RATE_URL ||
            "https://id.tradingeconomics.com/japan/interest-rate",
        fallbackTitle: "Suku Bunga Jepang",
    },
    hongKong: {
        cacheKey: "hong_kong_interest_rate_te",
        url:
            process.env.HONG_KONG_INTEREST_RATE_URL ||
            "https://id.tradingeconomics.com/hong-kong/interest-rate",
        fallbackTitle: "Suku Bunga Hong Kong",
    },
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function parseLocaleNumber(input) {
    if (input == null) return null;

    let value = normalizeText(input)
        .replace(/%/g, "")
        .replace(/[^\d.,-]/g, "");

    if (!value) return null;

    const hasComma = value.includes(",");
    const hasDot = value.includes(".");

    if (hasComma && hasDot) {
        if (value.lastIndexOf(",") > value.lastIndexOf(".")) {
            value = value.replace(/\./g, "").replace(",", ".");
        } else {
            value = value.replace(/,/g, "");
        }
    } else if (hasComma) {
        if (/^-?\d{1,3}(,\d{3})+$/.test(value)) {
            value = value.replace(/,/g, "");
        } else {
            value = value.replace(",", ".");
        }
    } else if (hasDot) {
        if (/^-?\d{1,3}(\.\d{3})+$/.test(value)) {
            value = value.replace(/\./g, "");
        }
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseTeTimestamp(raw) {
    if (!raw || !/^\d{14}$/.test(raw)) return null;

    const year = raw.slice(0, 4);
    const month = raw.slice(4, 6);
    const day = raw.slice(6, 8);
    const hour = raw.slice(8, 10);
    const minute = raw.slice(10, 12);
    const second = raw.slice(12, 14);

    if (hour === "00" && minute === "00" && second === "00") {
        return `${year}-${month}-${day}`;
    }

    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

async function getHtmlWithRetry(url, tries = 3) {
    let lastError;

    for (let i = 1; i <= tries; i += 1) {
        try {
            const response = await axios.get(url, {
                timeout: 20000,
                httpAgent,
                httpsAgent,
                maxRedirects: 5,
                decompress: true,
                validateStatus: (status) => status >= 200 && status < 400,
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
            });

            return response.data;
        } catch (error) {
            lastError = error;
            if (i === tries) throw lastError;
            await sleep(500 * i);
        }
    }

    throw lastError;
}

function findTableByHeaders($, expectedHeaders) {
    const expected = expectedHeaders.map((header) => header.toLowerCase());

    return $("table")
        .filter((_, table) => {
            const headers = $(table)
                .find("th")
                .map((__, th) => normalizeText($(th).text()).toLowerCase())
                .get()
                .filter(Boolean);

            if (!headers.length) return false;
            return expected.every((header) => headers.includes(header));
        })
        .first();
}

function getRowCells($, row) {
    return $(row)
        .find("td, th")
        .map((_, cell) => normalizeText($(cell).text()))
        .get()
        .filter(Boolean);
}

function parseStatsTable($) {
    const table = findTableByHeaders($, [
        "Realisasi",
        "Sebelum Ini",
        "Tertinggi",
        "Paling Rendah",
        "Tanggal",
        "Satuan",
        "Frekuensi",
    ]);

    if (!table.length) {
        throw new Error("Tabel statistik interest rate TradingEconomics tidak ditemukan.");
    }

    let values = null;
    table.find("tr").each((_, row) => {
        const cells = getRowCells($, row);
        if (cells.length >= 7 && cells[0].toLowerCase() !== "realisasi") {
            values = cells.slice(0, 7);
            return false;
        }
        return undefined;
    });

    if (!values || values.length < 7) {
        throw new Error("Baris statistik interest rate TradingEconomics tidak terbaca.");
    }

    return {
        actual: parseLocaleNumber(values[0]),
        previous: parseLocaleNumber(values[1]),
        highest: parseLocaleNumber(values[2]),
        lowest: parseLocaleNumber(values[3]),
        date_range: values[4],
        unit: values[5],
        frequency: values[6],
        raw: {
            actual: values[0],
            previous: values[1],
            highest: values[2],
            lowest: values[3],
            date_range: values[4],
            unit: values[5],
            frequency: values[6],
        },
    };
}

function parseReferenceRow($) {
    const table = findTableByHeaders($, [
        "Terakhir",
        "Sebelum Ini",
        "Satuan",
        "Referensi",
    ]);

    if (!table.length) return null;

    let rowValues = null;
    table.find("tr").each((_, row) => {
        const cells = getRowCells($, row);
        if (cells.length >= 5 && /Suku Bunga|Interest Rate|Federal/i.test(cells[0])) {
            rowValues = cells.slice(0, 5);
            return false;
        }
        return undefined;
    });

    if (!rowValues) return null;

    return {
        indicator: rowValues[0],
        last: parseLocaleNumber(rowValues[1]),
        previous: parseLocaleNumber(rowValues[2]),
        unit: rowValues[3],
        reference: rowValues[4],
        raw: {
            last: rowValues[1],
            previous: rowValues[2],
            unit: rowValues[3],
            reference: rowValues[4],
        },
    };
}

function parseCalendarRows($) {
    const calendarTable = $("#calendar").first();
    const table = calendarTable.length
        ? calendarTable
        : findTableByHeaders($, ["Kalender", "GMT", "Realisasi", "Sebelum Ini"]);

    if (!table.length) return [];

    const rows = [];
    table.find("tr[data-id], tbody tr, > tr").each((_, row) => {
        const tds = $(row).find("td");
        if (tds.length < 6) return;

        const date = normalizeText(tds.eq(0).text());
        const time = normalizeText(tds.eq(1).text());
        const event = normalizeText(tds.eq(2).text());
        const reference = normalizeText(tds.eq(3).text()) || null;
        const actualRaw = normalizeText(tds.eq(4).text()) || null;
        const previousRaw = normalizeText(tds.eq(5).text()) || null;
        const consensusRaw = normalizeText(tds.eq(6).text()) || null;

        if (!date || !event) return;

        rows.push({
            date,
            time: time || null,
            event,
            reference,
            actual: parseLocaleNumber(actualRaw),
            previous: parseLocaleNumber(previousRaw),
            consensus: parseLocaleNumber(consensusRaw),
            actual_raw: actualRaw,
            previous_raw: previousRaw,
            consensus_raw: consensusRaw,
        });
    });

    return rows.slice(0, 5);
}

function parsePage(html, config) {
    const $ = cheerio.load(html);
    const stats = parseStatsTable($);
    const reference = parseReferenceRow($);
    const title =
        normalizeText($("h1").first().text()) ||
        normalizeText($("title").first().text()) ||
        config.fallbackTitle;
    const description =
        $('meta[name="description"]').attr("content")?.trim() || null;
    const lastUpdateRaw =
        html.match(/var\s+TELastUpdate\s*=\s*'(\d{14})'/)?.[1] || null;

    return {
        source: config.url,
        title,
        description,
        rate: stats.actual,
        previous_rate: stats.previous,
        historical_high: stats.highest,
        historical_low: stats.lowest,
        date_range: stats.date_range,
        unit: reference?.unit || stats.unit,
        frequency: stats.frequency,
        reference_period: reference?.reference || null,
        source_last_update: parseTeTimestamp(lastUpdateRaw),
        source_last_update_raw: lastUpdateRaw,
        calendar: parseCalendarRows($),
        raw: {
            stats: stats.raw,
            reference: reference?.raw || null,
        },
        fetched_at: new Date().toISOString(),
    };
}

async function fetchTradingEconomicsInterestRateCached(
    config,
    { bypassCache = false } = {}
) {
    const now = Date.now();
    const cache = memoryCache.get(config.cacheKey);

    if (!bypassCache) {
        try {
            const cached = await getCache(config.cacheKey);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                    return { ...cached.payload, cache: "HIT_DB" };
                }
            }
        } catch (error) {
            console.error(
                `Gagal membaca cache DB ${config.cacheKey}:`,
                error.message
            );
        }
    }

    if (!bypassCache && cache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const html = await getHtmlWithRetry(config.url, 3);
    const payload = parsePage(html, config);

    memoryCache.set(config.cacheKey, { at: now, payload });

    try {
        await setCache(config.cacheKey, payload, payload.fetched_at);
    } catch (error) {
        console.error(`Gagal menulis cache DB ${config.cacheKey}:`, error.message);
    }

    return { ...payload, cache: "MISS" };
}

async function fetchUsInterestRateCached(options = {}) {
    return fetchTradingEconomicsInterestRateCached(
        TE_INTEREST_RATE_CONFIGS.us,
        options
    );
}

async function fetchJapanInterestRateCached(options = {}) {
    return fetchTradingEconomicsInterestRateCached(
        TE_INTEREST_RATE_CONFIGS.japan,
        options
    );
}

async function fetchHongKongInterestRateCached(options = {}) {
    return fetchTradingEconomicsInterestRateCached(
        TE_INTEREST_RATE_CONFIGS.hongKong,
        options
    );
}

module.exports = {
    fetchTradingEconomicsInterestRateCached,
    fetchUsInterestRateCached,
    fetchJapanInterestRateCached,
    fetchHongKongInterestRateCached,
};
