const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { getCache, setCache } = require("./cacheStore");
const { parseIndoDate, normalizeUrl } = require("../utils/text");

const BI_RATE_URL_ID =
    process.env.BI_RATE_URL ||
    "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx";

const BI_RATE_URL_EN = "https://www.bi.go.id/en/statistik/indikator/bi-rate.aspx";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.BI_RATE_TIMEOUT_MS || 20000);
const MAX_PAGE_COUNT = Number(process.env.BI_RATE_MAX_PAGES || 50);
const CURL_MAX_BUFFER = 20 * 1024 * 1024;
const CACHE_KEY = "bi_rate";

let cache = { fetchedAt: 0, payload: null };

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const DEFAULT_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAxiosClient() {
    return axios.create({
        timeout: REQUEST_TIMEOUT_MS,
        httpAgent,
        httpsAgent,
        decompress: true,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
    });
}

function mergeCookieHeader(currentHeader, setCookieHeader) {
    const cookies = new Map();

    for (const pair of String(currentHeader || "").split(/;\s*/)) {
        if (!pair) continue;
        const separatorIndex = pair.indexOf("=");
        if (separatorIndex <= 0) continue;
        cookies.set(
            pair.slice(0, separatorIndex),
            pair.slice(separatorIndex + 1)
        );
    }

    const newCookies = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader
          ? [setCookieHeader]
          : [];

    for (const rawCookie of newCookies) {
        const pair = String(rawCookie).split(";")[0].trim();
        const separatorIndex = pair.indexOf("=");
        if (separatorIndex <= 0) continue;
        cookies.set(
            pair.slice(0, separatorIndex),
            pair.slice(separatorIndex + 1)
        );
    }

    return Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

function isRetryableRequestError(error) {
    const code = String(error?.code || "").toUpperCase();
    return (
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "ECONNABORTED" ||
        code === "EPROTO" ||
        code === "EAI_AGAIN" ||
        code === "UND_ERR_SOCKET" ||
        code === "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"
    );
}

function createTempFile(prefix, contents = "") {
    const name = `${prefix}-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.tmp`;
    const filePath = path.join(os.tmpdir(), name);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
}

function createRequestSession() {
    return {
        client: createAxiosClient(),
        cookieHeader: "",
        cookieFile: createTempFile("bi-rate-cookie"),
    };
}

function cleanupRequestSession(session) {
    if (!session?.cookieFile) return;
    try {
        fs.unlinkSync(session.cookieFile);
    } catch (_) {
        // ignore temp cleanup error
    }
}

function requestWithCurl({ session, url, method = "GET", form = null }) {
    const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
    const args = [
        "-sS",
        "-L",
        "--http1.1",
        "--tlsv1.2",
        "-A",
        DEFAULT_HEADERS["User-Agent"],
        "-H",
        `Accept: ${DEFAULT_HEADERS.Accept}`,
        "-H",
        `Accept-Language: ${DEFAULT_HEADERS["Accept-Language"]}`,
        "-H",
        `Cache-Control: ${DEFAULT_HEADERS["Cache-Control"]}`,
        "-H",
        `Pragma: ${DEFAULT_HEADERS.Pragma}`,
        "-H",
        `Connection: ${DEFAULT_HEADERS.Connection}`,
        "-c",
        session.cookieFile,
        "-b",
        session.cookieFile,
    ];

    let bodyFile = null;

    try {
        if (method === "POST" && form) {
            bodyFile = createTempFile(
                "bi-rate-form",
                new URLSearchParams(form).toString()
            );
            args.push(
                "-X",
                "POST",
                "-H",
                "Content-Type: application/x-www-form-urlencoded",
                "--data-binary",
                `@${bodyFile}`
            );
        }

        args.push(url);

        return execFileSync(curlCommand, args, {
            encoding: "utf8",
            maxBuffer: CURL_MAX_BUFFER,
        });
    } finally {
        if (bodyFile) {
            try {
                fs.unlinkSync(bodyFile);
            } catch (_) {
                // ignore temp cleanup error
            }
        }
    }
}

async function requestHtml({
    session,
    url,
    method = "GET",
    form = null,
    tries = 3,
}) {
    let lastError;

    for (let attempt = 1; attempt <= tries; attempt += 1) {
        try {
            const response = await session.client.request({
                method,
                url,
                headers: {
                    ...DEFAULT_HEADERS,
                    ...(method === "POST"
                        ? {
                              "Content-Type":
                                  "application/x-www-form-urlencoded",
                          }
                        : {}),
                    ...(session.cookieHeader
                        ? { Cookie: session.cookieHeader }
                        : {}),
                },
                data:
                    method === "POST" && form
                        ? new URLSearchParams(form).toString()
                        : undefined,
                responseType: "text",
            });

            session.cookieHeader = mergeCookieHeader(
                session.cookieHeader,
                response.headers?.["set-cookie"]
            );

            return response.data;
        } catch (error) {
            lastError = error;
            if (attempt < tries) {
                await sleep(500 * attempt);
            }
        }
    }

    if (lastError && isRetryableRequestError(lastError)) {
        try {
            return requestWithCurl({ session, url, method, form });
        } catch (curlError) {
            curlError.original = lastError.message;
            throw curlError;
        }
    }

    throw lastError;
}

function getBiRateTable($) {
    let table = $("table")
        .filter((_, el) => {
            const text = $(el).text();
            return text.includes("BI-Rate") && text.includes("Tanggal");
        })
        .first();

    if (!table.length) {
        table = $("table").first();
    }

    return table;
}

function scrapeFromHtml(html) {
    const $ = cheerio.load(html);
    const table = getBiRateTable($);

    if (!table.length) {
        throw new Error("Tabel BI-Rate tidak ditemukan pada halaman BI.");
    }

    let rows = table.find("tbody tr");
    if (!rows.length) rows = table.find("tr").slice(1);

    const items = [];

    rows.each((_, row) => {
        const cells = $(row).find("td, th");
        if (cells.length < 4) return;

        const rawDate = cells.eq(1).text().trim();
        const rawRate = cells.eq(2).text().trim();
        const linkHref = $(row).find("a").first().attr("href");

        const looksLikeRate = /%/.test(rawRate) || /\d/.test(rawRate);
        const looksLikeDate =
            /\d{1,2}\s+[A-Za-z]+\s+\d{4}/.test(rawDate) ||
            /\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDate);

        if (!looksLikeRate || !looksLikeDate) return;

        const rate = Number(rawRate.replace("%", "").replace(",", ".").trim());

        items.push({
            date: parseIndoDate(rawDate) || rawDate,
            rate: Number.isFinite(rate) ? rate : rawRate,
            press_release_url: normalizeUrl(linkHref),
            raw_date: rawDate,
            raw_rate: rawRate,
        });
    });

    if (!items.length) {
        throw new Error("Tidak ada data BI-Rate yang terbaca dari tabel.");
    }

    return items;
}

function getHiddenFieldValue($, name) {
    return $(`input[name="${name}"]`).attr("value") || "";
}

function getNextPagerName(html) {
    const $ = cheerio.load(html);
    return (
        $('span[id$="DataPagerBI7DRR"] input.next:not([disabled])')
            .first()
            .attr("name") || null
    );
}

function buildNextPageForm(html) {
    const $ = cheerio.load(html);
    const nextPagerName = getNextPagerName(html);

    if (!nextPagerName) return null;

    const dateStartName = $('input[id$="TextBoxDateStart"]').attr("name");
    const dateStartHiddenName = $('input[id$="HiddenFieldDateFrom"]').attr(
        "name"
    );
    const dateEndName = $('input[id$="TextBoxDateEnd"]').attr("name");
    const dateEndHiddenName = $('input[id$="HiddenFieldDateTo"]').attr("name");

    const form = {
        __EVENTTARGET: "",
        __EVENTARGUMENT: "",
        __VIEWSTATE: getHiddenFieldValue($, "__VIEWSTATE"),
        __VIEWSTATEGENERATOR: getHiddenFieldValue($, "__VIEWSTATEGENERATOR"),
        __EVENTVALIDATION: getHiddenFieldValue($, "__EVENTVALIDATION"),
        [`${nextPagerName}.x`]: "10",
        [`${nextPagerName}.y`]: "10",
    };

    if (dateStartName) form[dateStartName] = "";
    if (dateStartHiddenName) form[dateStartHiddenName] = "";
    if (dateEndName) form[dateEndName] = "";
    if (dateEndHiddenName) form[dateEndHiddenName] = "";

    return form;
}

async function fetchPagedBiRate(url) {
    const session = createRequestSession();

    try {
        let html = await requestHtml({
            session,
            url,
            method: "GET",
            tries: 3,
        });

        const items = [];
        const seen = new Set();
        const seenPages = new Set();

        for (let pageIndex = 1; pageIndex <= MAX_PAGE_COUNT; pageIndex += 1) {
            const pageItems = scrapeFromHtml(html);
            const pageSignature = pageItems
                .map((item) => `${item.raw_date}|${item.raw_rate}`)
                .join("||");

            if (!pageSignature || seenPages.has(pageSignature)) {
                break;
            }
            seenPages.add(pageSignature);

            for (const item of pageItems) {
                const key = `${item.raw_date}|${item.raw_rate}|${item.press_release_url || ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push(item);
            }

            const nextForm = buildNextPageForm(html);
            if (!nextForm) break;

            html = await requestHtml({
                session,
                url,
                method: "POST",
                form: nextForm,
                tries: 3,
            });
        }

        if (!items.length) {
            throw new Error("Histori BI-Rate kosong setelah pagination selesai.");
        }

        return items;
    } finally {
        cleanupRequestSession(session);
    }
}

function filterByDate(items, { from, to }) {
    return items.filter((item) => {
        if (!item.date || item.date.length !== 10) return true;
        if (from && item.date < from) return false;
        if (to && item.date > to) return false;
        return true;
    });
}

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

    return items.map((item) => {
        const text = (item.raw_date || item.date || "")
            .replace(/\s+/g, " ")
            .trim();
        const match = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);

        if (!match) return item;

        const day = match[1].padStart(2, "0");
        const month = months[match[2].toLowerCase()];
        const year = match[3];

        if (!month) return item;
        return { ...item, date: `${year}-${month}-${day}` };
    });
}

async function fetchBiRate({ from, to } = {}) {
    const now = Date.now();

    try {
        const cached = await getCache(CACHE_KEY);
        if (cached && cached.fetched_at) {
            const fetchedAt = Date.parse(cached.fetched_at);
            if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                const filtered = filterByDate(cached.payload?.data || [], {
                    from,
                    to,
                });
                return {
                    source: cached.payload?.source,
                    count: filtered.length,
                    data: filtered,
                    fetched_at: cached.fetched_at,
                    cache: "HIT_DB",
                };
            }
        }
    } catch (error) {
        console.error("Gagal membaca cache DB BI Rate:", error.message);
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

    try {
        const items = await fetchPagedBiRate(BI_RATE_URL_ID);
        const filtered = filterByDate(items, { from, to });
        const fetchedAt = new Date().toISOString();
        const cachePayload = {
            source: BI_RATE_URL_ID,
            count: items.length,
            data: items,
            fetched_at: fetchedAt,
        };

        const payload = {
            source: BI_RATE_URL_ID,
            count: filtered.length,
            data: filtered,
            fetched_at: fetchedAt,
        };

        cache = {
            fetchedAt: now,
            payload: cachePayload,
        };

        try {
            await setCache(CACHE_KEY, cachePayload, payload.fetched_at);
        } catch (error) {
            console.error("Gagal menulis cache DB BI Rate:", error.message);
        }

        return { ...payload, cache: "MISS" };
    } catch (idError) {
        try {
            const items = normalizeEnDates(await fetchPagedBiRate(BI_RATE_URL_EN));
            const filtered = filterByDate(items, { from, to });
            const fetchedAt = new Date().toISOString();
            const cachePayload = {
                source: BI_RATE_URL_EN,
                count: items.length,
                data: items,
                fetched_at: fetchedAt,
            };

            const payload = {
                source: BI_RATE_URL_EN,
                count: filtered.length,
                data: filtered,
                fetched_at: fetchedAt,
            };

            cache = {
                fetchedAt: now,
                payload: cachePayload,
            };

            try {
                await setCache(CACHE_KEY, cachePayload, payload.fetched_at);
            } catch (error) {
                console.error("Gagal menulis cache DB BI Rate:", error.message);
            }

            return { ...payload, cache: "MISS_FALLBACK_EN" };
        } catch (enError) {
            const error = new Error(
                enError.message || idError.message || "Unknown error"
            );
            error.original = {
                id: idError.message,
                en: enError.message,
            };
            throw error;
        }
    }
}

module.exports = {
    fetchBiRate,
};
