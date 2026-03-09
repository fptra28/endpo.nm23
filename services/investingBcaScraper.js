// services/investingBcaScraper.js
const { chromium } = require("playwright");

const INVESTING_BCA_URL = "https://id.investing.com/equities/bnk-central-as";
const INVESTING_BRI_URL = "https://id.investing.com/equities/bank-rakyat-in";
const INVESTING_BMRI_URL = "https://id.investing.com/equities/bank-mandiri-t";
const INVESTING_TLKM_URL = "https://id.investing.com/equities/telkom-indones";
const INVESTING_ASII_URL = "https://id.investing.com/equities/astra-intl-tbk";
const INVESTING_BNII_URL = "https://id.investing.com/equities/bank-bni-tbk";
const INVESTING_UNVR_URL = "https://id.investing.com/equities/unilever-indon";
const INVESTING_ICBP_URL = "https://id.investing.com/equities/indofood-cbp";
const INVESTING_ADRO_URL = "https://id.investing.com/equities/adaro-energy-t";
const INVESTING_GOTO_URL =
    "https://id.investing.com/equities/goto-gojek-tokopedia-pt";
const CACHE_TTL_MS = Number(process.env.INVESTING_CACHE_TTL_MS || 60 * 1000);

let cache = { at: 0, payload: null };

function parseLocaleNumber(input) {
    if (!input) return null;
    const raw = String(input).trim();
    if (!raw) return null;

    let s = raw.replace(/\s+/g, "").replace(/[^\d.,-]/g, "");
    if (!s) return null;

    const hasComma = s.includes(",");
    const hasDot = s.includes(".");

    if (hasComma && hasDot) {
        if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
            // 2.345,67 -> 2345.67
            s = s.replace(/\./g, "").replace(",", ".");
        } else {
            // 2,345.67 -> 2345.67
            s = s.replace(/,/g, "");
        }
    } else if (hasComma && !hasDot) {
        // 2345,67 -> 2345.67
        s = s.replace(",", ".");
    } else if (!hasComma && hasDot) {
        // IDR biasanya ribuan pakai titik: 3.610 -> 3610
        if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
            s = s.replace(/\./g, "");
        }
    } else {
        // 2345.67 or 234567
        s = s.replace(/,/g, "");
    }

    const num = Number(s);
    return Number.isFinite(num) ? num : null;
}

async function fetchInvestingSingle({ url, symbol }) {
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            locale: "id-ID",
            extraHTTPHeaders: {
                "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
            },
        });

        const page = await context.newPage();

        // percepat load dengan blok resource berat
        await page.route("**/*", (route) => {
            const type = route.request().resourceType();
            if (["image", "media", "font", "stylesheet"].includes(type)) {
                return route.abort();
            }
            return route.continue();
        });

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });

        // tunggu elemen harga utama
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            const pickText = (selectors) => {
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.textContent) {
                        const t = el.textContent.trim();
                        if (t) return t;
                    }
                }
                return null;
            };

            const title = pickText([
                'h1[data-test="instrument-title"]',
                'h1[class*="instrument-title"]',
                "h1",
            ]);

            let ticker = null;
            if (title) {
                const m = title.match(/\(([^)]+)\)\s*$/);
                if (m && m[1]) ticker = m[1].trim();
            }

            const last = pickText([
                '[data-test="instrument-price-last"]',
                "span.instrument-price_last__KQzyA",
                "div.instrument-price_last__KQzyA",
            ]);

            const change = pickText([
                '[data-test="instrument-price-change"]',
                "span.instrument-price_change__2fF5J",
            ]);

            const changePercent = pickText([
                '[data-test="instrument-price-change-percent"]',
                "span.instrument-price_change-percent__1FZ8S",
            ]);

            const currency = pickText([
                '[data-test="instrument-price-currency"]',
                '[data-test="instrument-currency"]',
                "span.instrument-price_currency__3C2mb",
            ]);

            return {
                title,
                ticker,
                last,
                change,
                change_percent: changePercent,
                currency,
            };
        });

        if (!data || !data.last) {
            throw new Error("Harga terakhir tidak ditemukan di halaman Investing.");
        }

        const outSymbol = data.ticker || symbol;
        return {
            source: url,
            symbol: outSymbol,
            name: data.title || symbol,
            last: parseLocaleNumber(data.last),
            change: parseLocaleNumber(data.change),
            change_percent: parseLocaleNumber(data.change_percent),
            currency: data.currency || null,
            raw: data,
            fetched_at: new Date().toISOString(),
        };
    } catch (error) {
        throw new Error(`Gagal scrapping Investing: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function fetchInvestingBcaCached({ bypassCache = false } = {}) {
    const now = Date.now();

    if (!bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const payload = await fetchInvestingSingle({
        url: INVESTING_BCA_URL,
        symbol: "BNK Central AS",
    });
    cache = { at: now, payload };
    return { ...payload, cache: "MISS" };
}

async function fetchInvestingMultipleCached({ bypassCache = false } = {}) {
    const now = Date.now();

    if (!bypassCache && cache.payload && now - cache.at < CACHE_TTL_MS) {
        return { ...cache.payload, cache: "HIT" };
    }

    const items = [];
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_BCA_URL,
            symbol: "BNK Central AS",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_BRI_URL,
            symbol: "Bank Rakyat In",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_BMRI_URL,
            symbol: "Bank Mandiri T",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_TLKM_URL,
            symbol: "Telkom Indones",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_ASII_URL,
            symbol: "Astra Intl Tbk",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_BNII_URL,
            symbol: "Bank BNI Tbk",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_UNVR_URL,
            symbol: "Unilever Indon",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_ICBP_URL,
            symbol: "Indofood CBP",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_ADRO_URL,
            symbol: "Adaro Energy T",
        })
    );
    items.push(
        await fetchInvestingSingle({
            url: INVESTING_GOTO_URL,
            symbol: "GoTo Gojek Tokopedia PT",
        })
    );

    const payload = {
        source: [
            INVESTING_BCA_URL,
            INVESTING_BRI_URL,
            INVESTING_BMRI_URL,
            INVESTING_TLKM_URL,
            INVESTING_ASII_URL,
            INVESTING_BNII_URL,
            INVESTING_UNVR_URL,
            INVESTING_ICBP_URL,
            INVESTING_ADRO_URL,
            INVESTING_GOTO_URL,
        ],
        count: items.length,
        data: items,
        fetched_at: new Date().toISOString(),
    };

    cache = { at: now, payload };
    return { ...payload, cache: "MISS" };
}

module.exports = { fetchInvestingBcaCached, fetchInvestingMultipleCached };
