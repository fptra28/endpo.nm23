const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const { getCache, setCache } = require("./cacheStore");

const BASE_URL = "https://bappebti.go.id";

const CATEGORY_SOURCES = [
    {
        key: "sk_kep_kepala_bappebti",
        label: "SK/ Kep. Kepala Bappebti",
        url: "https://bappebti.go.id/pbk/sk_kep_kepala_bappebti",
    },
    {
        key: "peraturan_pemerintah",
        label: "Peraturan Pemerintah",
        url: "https://bappebti.go.id/pbk/peraturan_pemerintah",
    },
    {
        key: "undang_undang",
        label: "Undang Undang",
        url: "https://bappebti.go.id/pbk/undang_undang",
    },
    {
        key: "keppres",
        label: "Keputusan Presiden",
        url: "https://bappebti.go.id/pbk/keppres",
    },
    {
        key: "per_kep_menteri",
        label: "Per./ Kep. Menteri",
        url: "https://bappebti.go.id/pbk/per_kep_menteri",
    },
    {
        key: "edaran_kepala_bappebti",
        label: "Edaran Kepala Bappebti",
        url: "https://bappebti.go.id/pbk/edaran_kepala_bappebti",
    },
];

const CACHE_TTL_MS = Number(
    process.env.BAPPEBTI_PBK_CACHE_TTL_MS || 6 * 60 * 60 * 1000
);
const DEFAULT_MAX_PAGES = Number(
    process.env.BAPPEBTI_PBK_MAX_PAGES_PER_CATEGORY || 5
);
const CACHE_KEY = "bappebti_pbk_regulasi";

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const httpsAgentInsecure = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
});

const DEFAULT_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
};

let cache = { at: 0, payload: null };

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeBappebtiUrl(url) {
    const raw = cleanText(url);
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) {
        return raw.replace("https://bappebti.go.id//", "https://bappebti.go.id/");
    }
    if (raw.startsWith("//")) {
        return `https:${raw}`;
    }
    if (raw.startsWith("/")) {
        return `${BASE_URL}${raw}`;
    }
    return `${BASE_URL}/${raw}`;
}

function parseMonthToken(token) {
    const value = cleanText(token).toLowerCase();
    const normalized = value
        .replace(/\./g, "")
        .replace(/nopember/g, "november")
        .replace(/^nop$/g, "november")
        .replace(/^agu$/g, "agustus")
        .replace(/^agt$/g, "agustus")
        .replace(/^okt$/g, "oktober")
        .replace(/^des$/g, "desember");

    const mapping = {
        januari: "01",
        january: "01",
        jan: "01",
        februari: "02",
        february: "02",
        feb: "02",
        maret: "03",
        march: "03",
        mar: "03",
        april: "04",
        apr: "04",
        mei: "05",
        may: "05",
        juni: "06",
        june: "06",
        jun: "06",
        juli: "07",
        july: "07",
        jul: "07",
        agustus: "08",
        august: "08",
        aug: "08",
        september: "09",
        sept: "09",
        sep: "09",
        oktober: "10",
        october: "10",
        oct: "10",
        november: "11",
        nov: "11",
        desember: "12",
        december: "12",
        dec: "12",
    };

    return mapping[normalized] || null;
}

function parseListDateIso(dayText, monthYearText) {
    const day = cleanText(dayText).replace(/[^\d]/g, "");
    const parts = cleanText(monthYearText).split(" ").filter(Boolean);
    if (!day || parts.length < 2) return null;

    const month = parseMonthToken(parts[0]);
    const yearMatch = parts.find((part) => /\d{4}/.test(part));
    const year = yearMatch ? yearMatch.match(/\d{4}/)[0] : null;
    if (!month || !year) return null;

    return `${year}-${month}-${day.padStart(2, "0")}`;
}

function normalizeTitle(value) {
    return cleanText(value).replace(/^[\u203a\u25ba]+\s*/, "");
}

function stripPrefix(value, prefix) {
    return cleanText(value).replace(prefix, "").trim() || null;
}

function isCertificateError(error) {
    const code = String(error?.code || "").toUpperCase();
    const message = String(error?.message || "");
    return (
        code.includes("UNABLE_TO_VERIFY") ||
        code.includes("SELF_SIGNED") ||
        code.includes("CERT") ||
        /certificate|unable to verify/i.test(message)
    );
}

async function axiosGetRaw(url, { insecure = false } = {}) {
    return axios.get(url, {
        headers: DEFAULT_HEADERS,
        timeout: 25000,
        httpAgent,
        httpsAgent: insecure ? httpsAgentInsecure : httpsAgent,
        decompress: true,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
    });
}

async function axiosGetWithRetry(url, tries = 3) {
    let lastError;
    let insecure = false;
    let attempts = 0;

    while (attempts < tries) {
        try {
            const response = await axiosGetRaw(url, { insecure });
            return {
                html: response.data,
                insecureTlsUsed: insecure,
            };
        } catch (error) {
            lastError = error;
            if (!insecure && isCertificateError(error)) {
                insecure = true;
                continue;
            }
            attempts += 1;
            if (attempts >= tries) throw lastError;
            await sleep(500 * attempts);
        }
    }

    throw lastError;
}

function extractCategoryLabel($, fallbackLabel) {
    const fromBreadcrumb = cleanText($(".breadcrumb-standart .container h2").first().text());
    if (fromBreadcrumb) return fromBreadcrumb;

    const title = cleanText($("title").first().text()).replace(
        /^Bappebti Website\s*-\s*/i,
        ""
    );
    return title || fallbackLabel;
}

function parseNewsItems($) {
    const rows = $(".site-content .news-3 > .news-3-box").filter((_, el) => {
        const $el = $(el);
        return $el.find(".news-3-content h4 a, .news-3-content h5 a").length > 0;
    });

    const items = [];
    rows.each((_, row) => {
        const $row = $(row);
        const titleAnchor = $row
            .find(".news-3-content h5 a, .news-3-content h4 a, .news-3-content a")
            .first();
        const title = normalizeTitle(titleAnchor.text());
        const detailUrl = normalizeBappebtiUrl(titleAnchor.attr("href"));

        if (!title && !detailUrl) return;

        const day = cleanText($row.find(".news-day-small").first().text());
        const monthYear = cleanText($row.find(".news-month").first().text());
        const tanggal = cleanText(`${day} ${monthYear}`);
        const tanggalIso = parseListDateIso(day, monthYear);
        const tupoksi = stripPrefix(
            $row.find(".news-3-content h6").first().text(),
            /^Tupoksi\s*:\s*/i
        );
        const tentang = stripPrefix(
            $row.find(".news-3-content p").first().text(),
            /^Tentang\s*:\s*/i
        );

        items.push({
            judul: title || null,
            detail_url: detailUrl,
            tanggal: tanggal || null,
            tanggal_iso: tanggalIso,
            tupoksi,
            tentang,
            links: null,
        });
    });

    return items;
}

function parseAccordionItems($) {
    const panels = $(".site-content .panel-group .panel");
    const items = [];

    panels.each((_, panel) => {
        const $panel = $(panel);
        const heading = normalizeTitle($panel.find(".panel-heading h5 a").first().text());
        const tentangEl = $panel.find(".panel-body h5").first();
        const tentang = stripPrefix(tentangEl.text(), /^TENTANG\s*/i);
        const tentangLink = normalizeBappebtiUrl(tentangEl.find("a").first().attr("href"));

        const linkSeen = new Set();
        const links = [];
        $panel.find(".panel-body ul li a").each((__, anchor) => {
            const $anchor = $(anchor);
            const linkUrl = normalizeBappebtiUrl($anchor.attr("href"));
            const linkTitle = normalizeTitle($anchor.text());
            if (!linkUrl) return;
            if (linkSeen.has(linkUrl)) return;
            linkSeen.add(linkUrl);
            links.push({
                judul: linkTitle || null,
                url: linkUrl,
            });
        });

        const detailUrl = tentangLink || links[0]?.url || null;
        if (!heading && !detailUrl) return;

        items.push({
            judul: heading || null,
            detail_url: detailUrl,
            tanggal: null,
            tanggal_iso: null,
            tupoksi: null,
            tentang: tentang || null,
            links: links.length ? links : null,
        });
    });

    return items;
}

function parseNextPageUrl($) {
    const nextHref = $(".site-content .info-pagination a[rel='next']").first().attr("href");
    return normalizeBappebtiUrl(nextHref);
}

function parseCategoryPage(html, fallbackLabel) {
    const $ = cheerio.load(html);
    const label = extractCategoryLabel($, fallbackLabel);
    const accordionItems = parseAccordionItems($);

    if (accordionItems.length) {
        return {
            label,
            mode: "accordion",
            items: accordionItems,
            nextUrl: null,
        };
    }

    return {
        label,
        mode: "news",
        items: parseNewsItems($),
        nextUrl: parseNextPageUrl($),
    };
}

function dedupeItems(items) {
    const seen = new Set();
    const out = [];

    for (const item of items) {
        const key = cleanText(
            `${item?.detail_url || ""}|${item?.judul || ""}|${item?.tanggal || ""}`
        ).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }

    return out;
}

async function scrapeOneCategory(category, maxPages) {
    let currentUrl = category.url;
    const visited = new Set();
    const allItems = [];
    let pagesFetched = 0;
    let mode = "news";
    let label = category.label;
    let tlsInsecureFallbackUsed = false;

    while (
        currentUrl &&
        !visited.has(currentUrl) &&
        pagesFetched < maxPages
    ) {
        visited.add(currentUrl);

        const fetched = await axiosGetWithRetry(currentUrl, 3);
        const parsed = parseCategoryPage(fetched.html, label);
        tlsInsecureFallbackUsed = tlsInsecureFallbackUsed || fetched.insecureTlsUsed;

        pagesFetched += 1;
        mode = parsed.mode;
        label = parsed.label || label;
        allItems.push(...parsed.items);

        if (mode !== "news") break;
        if (!parsed.nextUrl) break;
        currentUrl = parsed.nextUrl;
    }

    const data = dedupeItems(allItems);

    return {
        key: category.key,
        label,
        source: category.url,
        mode,
        pages_fetched: pagesFetched,
        count: data.length,
        data,
        tls_insecure_fallback_used: tlsInsecureFallbackUsed,
    };
}

async function fetchBappebtiRegulasi({ bypassCache = false, maxPages = DEFAULT_MAX_PAGES } = {}) {
    const now = Date.now();
    const normalizedMaxPages = Number.isFinite(Number(maxPages))
        ? Math.max(1, Math.min(50, Math.floor(Number(maxPages))))
        : DEFAULT_MAX_PAGES;

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
            console.error("Gagal membaca cache DB Bappebti Regulasi:", error.message);
        }
    }

    if (!bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const categories = [];
    for (const source of CATEGORY_SOURCES) {
        categories.push(await scrapeOneCategory(source, normalizedMaxPages));
    }

    const payload = {
        source: CATEGORY_SOURCES.map((item) => item.url),
        max_pages_per_category: normalizedMaxPages,
        categories_count: categories.length,
        count: categories.reduce((sum, item) => sum + item.count, 0),
        data: categories,
        fetched_at: new Date().toISOString(),
    };

    cache = { at: now, payload };

    try {
        await setCache(CACHE_KEY, payload, payload.fetched_at);
    } catch (error) {
        console.error("Gagal menulis cache DB Bappebti Regulasi:", error.message);
    }

    return { ...payload, cache: "MISS" };
}

module.exports = {
    fetchBappebtiRegulasi,
};
