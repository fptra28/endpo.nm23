// services/idxIndicesScraper.js
const { launchChromium } = require("./browser");

const CACHE_TTL_MS = Number(process.env.TRADINGVIEW_CACHE_TTL_MS || 5 * 60 * 1000);
let cache = { at: 0, payload: null };

function buildPayload() {
    return {
        symbols: {
            tickers: ["IDX:COMPOSITE"],
            query: { types: [] },
        },
        columns: ["name", "close", "change", "volume"],
    };
}

function mapTradingViewRow(row) {
    if (!row || !Array.isArray(row.d)) return null;

    const [name, close, change, volume] = row.d;

    const last = typeof close === "number" ? close : null;
    const chg = typeof change === "number" ? change : null;

    let direction = "flat";
    if (chg !== null) {
        if (chg > 0) direction = "up";
        else if (chg < 0) direction = "down";
    }

    return {
        name: typeof name === "string" ? name : null,
        last,
        change: chg,
        change_percent: chg,
        volume: typeof volume === "number" ? volume : null,
        direction,
    };
}

async function fetchTradingViewComposite() {
    let browser;

    try {
        browser = await launchChromium();

        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            locale: "en-US",
            extraHTTPHeaders: {
                "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
            },
        });

        const page = await context.newPage();

        // Buka homepage dulu biar dapet context browser yang lebih natural
        await page.goto("https://www.tradingview.com/", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });

        const payload = buildPayload();

        const result = await page.evaluate(async (payload) => {
            const response = await fetch("https://scanner.tradingview.com/indonesia/scan", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "accept": "application/json, text/plain, */*",
                },
                body: JSON.stringify(payload),
            });

            const text = await response.text();

            let data = null;
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = null;
            }

            return {
                status: response.status,
                ok: response.ok,
                raw: text,
                data,
            };
        }, payload);

        if (!result.ok) {
            throw new Error(
                `TradingView HTTP ${result.status}: ${result.raw?.slice(0, 300) || "Unknown error"}`
            );
        }

        if (!result.data || !Array.isArray(result.data.data) || result.data.data.length === 0) {
            throw new Error("Data TradingView kosong atau format berubah.");
        }

        const composite = mapTradingViewRow(result.data.data[0]);

        if (!composite) {
            throw new Error("Gagal memetakan data IDX:COMPOSITE dari TradingView.");
        }

        return {
            source: "https://scanner.tradingview.com/indonesia/scan",
            indices: {
                composite,
                idx30: null,
                lq45: null,
                kompas100: null,
            },
            fetched_at: new Date().toISOString(),
        };
    } catch (error) {
        throw new Error(`Gagal akses TradingView via Playwright: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function fetchIdxIndicesCached() {
    const now = Date.now();

    if (cache.payload && now - cache.at < CACHE_TTL_MS) {
        return {
            ...cache.payload,
            cache: "HIT",
        };
    }

    const payload = await fetchTradingViewComposite();

    cache = {
        at: now,
        payload,
    };

    return {
        ...payload,
        cache: "MISS",
    };
}

module.exports = { fetchIdxIndicesCached };
