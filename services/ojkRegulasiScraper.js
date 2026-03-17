// services/ojkRegulasiScraper.js
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const { getCache, setCache } = require("./cacheStore");

const BASE_URL = "https://ojk.go.id/id/regulasi/default.aspx";

const CACHE_TTL_MS = Number(process.env.OJK_REGULASI_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const CACHE_KEY = "ojk_regulasi";

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

async function axiosPostWithRetry(url, body, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await axios.post(url, body, {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                    "Content-Type": "application/x-www-form-urlencoded",
                    Origin: "https://ojk.go.id",
                    Referer: BASE_URL,
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

function cleanText(input) {
    if (!input) return "";
    return String(input).replace(/\s+/g, " ").trim();
}

function normalizeOjkUrl(url) {
    if (!url) return null;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("/")) return `https://ojk.go.id${url}`;
    return `https://ojk.go.id/${url}`;
}

function parseCaption(caption) {
    if (!caption) return { jenis: null, sektor: null, tahun: null };
    const parts = caption
        .split("•")
        .map((p) => cleanText(p))
        .filter(Boolean);
    const jenis = parts[0] || null;
    const sektor = parts[1] || null;
    let tahun = null;
    const last = parts[2] || parts[parts.length - 1] || "";
    const m = last.match(/\b(19|20)\d{2}\b/);
    if (m) tahun = Number(m[0]);
    return { jenis, sektor, tahun };
}

function extractFormFields($) {
    const form = $("form#aspnetForm");
    const fields = {};

    form.find("input[name]").each((_, el) => {
        const $el = $(el);
        const name = $el.attr("name");
        if (!name) return;
        const type = ($el.attr("type") || "").toLowerCase();
        if (type === "checkbox" || type === "radio") {
            if ($el.attr("checked") !== undefined) {
                fields[name] = $el.attr("value") || "on";
            }
            return;
        }
        fields[name] = $el.attr("value") || "";
    });

    form.find("select[name]").each((_, el) => {
        const $el = $(el);
        const name = $el.attr("name");
        if (!name) return;
        const selected = $el.find("option[selected]").attr("value");
        if (selected !== undefined) {
            fields[name] = selected;
            return;
        }
        const first = $el.find("option").first().attr("value");
        fields[name] = first !== undefined ? first : "";
    });

    form.find("textarea[name]").each((_, el) => {
        const $el = $(el);
        const name = $el.attr("name");
        if (!name) return;
        fields[name] = $el.text() || "";
    });

    return fields;
}

function extractPager($) {
    const pager = $("#ctl00_PlaceHolderMain_ctl01_DataPagerArticles");
    if (!pager.length) {
        return { current: 1, pages: new Map(), nextTarget: null, prevTarget: null };
    }

    const pages = new Map();
    let nextTarget = null;
    let prevTarget = null;

    pager.find("a.pagingButton").each((_, el) => {
        const $el = $(el);
        const text = cleanText($el.text());
        const href = $el.attr("href") || "";
        const m = href.match(/__doPostBack\('([^']+)'/);
        if (!m) return;
        const target = m[1];

        if (/^\d+$/.test(text)) {
            pages.set(Number(text), target);
        }
        if ($el.hasClass("fa-arrow-right")) {
            nextTarget = target;
        }
        if ($el.hasClass("fa-arrow-left")) {
            prevTarget = target;
        }
    });

    const currentText = cleanText(pager.find("span.currentPagingButton").first().text());
    const current = /^\d+$/.test(currentText) ? Number(currentText) : 1;

    return { current, pages, nextTarget, prevTarget };
}

function parseItems($) {
    const rows = $("table.table-styled tbody tr");
    if (!rows.length) {
        return [];
    }

    const items = [];
    rows.each((_, row) => {
        const $row = $(row);
        const tds = $row.find("td");
        if (tds.length < 2) return;

        const nomor = cleanText(tds.eq(0).text());
        const titleEl = tds.eq(1).find("a").first();
        const title = cleanText(titleEl.text());
        const href = titleEl.attr("href") || null;
        const url = normalizeOjkUrl(href);
        const caption = cleanText(tds.eq(1).find(".caption").first().text());
        const meta = parseCaption(caption);

        if (!nomor && !title) return;

        items.push({
            nomor: nomor || null,
            judul: title || null,
            url,
            jenis: meta.jenis,
            sektor: meta.sektor,
            tahun: meta.tahun,
            raw_caption: caption || null,
        });
    });

    return items;
}

function parsePage(html) {
    const $ = cheerio.load(html);
    const items = parseItems($);
    const pager = extractPager($);
    const fields = extractFormFields($);
    return { items, pager, fields };
}

function isWafBlocked(html) {
    if (!html) return false;
    return /Request Rejected/i.test(html) && /support ID/i.test(html);
}

async function postBack(html, target) {
    const { fields } = parsePage(html);
    const payload = { ...fields, __EVENTTARGET: target, __EVENTARGUMENT: "" };
    const body = new URLSearchParams(payload).toString();
    const nextHtml = await axiosPostWithRetry(BASE_URL, body, 3);
    if (isWafBlocked(nextHtml)) {
        const err = new Error(
            "Pagination postback diblokir oleh WAF OJK. Saat ini hanya halaman pertama yang dapat di-scrape."
        );
        err.code = "WAF_BLOCKED";
        throw err;
    }
    return nextHtml;
}

async function fetchPageByNumber(page) {
    let html = await axiosGetWithRetry(BASE_URL, 3);
    let { items, pager } = parsePage(html);

    if (page <= 1) {
        return { page: 1, items, html };
    }

    let current = pager.current || 1;
    let guard = 0;
    let noProgress = 0;

    while (current !== page && guard < 200) {
        const prevCurrent = current;
        if (pager.pages.has(page)) {
            html = await postBack(html, pager.pages.get(page));
        } else if (page > current && pager.nextTarget) {
            html = await postBack(html, pager.nextTarget);
        } else if (page < current && pager.prevTarget) {
            html = await postBack(html, pager.prevTarget);
        } else {
            break;
        }

        const parsed = parsePage(html);
        items = parsed.items;
        pager = parsed.pager;
        current = pager.current || current + (page > current ? 1 : -1);
        if (current === prevCurrent) {
            noProgress += 1;
            if (noProgress >= 2) break;
        } else {
            noProgress = 0;
        }
        guard++;
    }

    return { page: current, items, html };
}

async function fetchPagesSequential(maxPages) {
    let html = await axiosGetWithRetry(BASE_URL, 3);
    let parsed = parsePage(html);
    let items = parsed.items;
    let pager = parsed.pager;
    let pagesFetched = 1;

    while (pagesFetched < maxPages && pager.nextTarget) {
        html = await postBack(html, pager.nextTarget);
        parsed = parsePage(html);
        items = items.concat(parsed.items);
        pager = parsed.pager;
        pagesFetched++;
    }

    return { pagesFetched, items };
}

async function fetchOjkRegulasi({ page = 1, maxPages = 1, bypassCache = false } = {}) {
    const now = Date.now();
    const wantSingleFirstPage = page === 1 && maxPages === 1;

    if (wantSingleFirstPage && !bypassCache) {
        try {
            const cached = await getCache(CACHE_KEY);
            if (cached && cached.fetched_at) {
                const fetchedAt = Date.parse(cached.fetched_at);
                if (Number.isFinite(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
                    return { ...cached.payload, cache: "HIT_DB" };
                }
            }
        } catch (e) {
            console.error("Gagal membaca cache DB OJK Regulasi:", e.message);
        }
    }

    if (wantSingleFirstPage && !bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    let payload;

    if (page && page > 1) {
        const out = await fetchPageByNumber(page);
        if (!out.items.length) {
            throw new Error("Tidak ada data regulasi terbaca dari halaman.");
        }
        if (out.page !== page) {
            throw new Error(
                "Pagination tidak bisa diakses (WAF OJK menolak postback). Saat ini hanya halaman pertama yang dapat di-scrape."
            );
        }
        payload = {
            source: BASE_URL,
            page: out.page,
            pages_fetched: 1,
            count: out.items.length,
            data: out.items,
            fetched_at: new Date().toISOString(),
        };
    } else {
        const out = await fetchPagesSequential(Math.max(1, maxPages));
        if (!out.items.length) {
            throw new Error("Tidak ada data regulasi terbaca dari tabel.");
        }
        if (maxPages > 1 && out.pagesFetched < maxPages) {
            throw new Error(
                "Pagination tidak bisa diakses (WAF OJK menolak postback). Saat ini hanya halaman pertama yang dapat di-scrape."
            );
        }
        payload = {
            source: BASE_URL,
            page: 1,
            pages_fetched: out.pagesFetched,
            count: out.items.length,
            data: out.items,
            fetched_at: new Date().toISOString(),
        };
    }

    if (wantSingleFirstPage) {
        cache = { at: now, payload };
        try {
            await setCache(CACHE_KEY, payload, payload.fetched_at);
        } catch (e) {
            console.error("Gagal menulis cache DB OJK Regulasi:", e.message);
        }
    }

    return { ...payload, cache: wantSingleFirstPage ? "MISS" : "BYPASS" };
}

module.exports = { fetchOjkRegulasi };
