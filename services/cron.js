const cron = require("node-cron");
const { fetchBiRate } = require("./scraper");
const { fetchBiFxCached } = require("./biFxScraper");
const { fetchInvestingMultipleCached } = require("./investingBcaScraper");
const { collectSignalSnapshot } = require("./signalService");

function startCron() {
    // jalan setiap hari jam 08:00 (Asia/Jakarta)
    cron.schedule("0 8 * * *", async () => {
        try {
            console.log("Running daily BI rate scraping...");
            await fetchBiRate();
            console.log("BI rate updated");
        } catch (err) {
            console.error("Cron scraping failed:", err.message);
        }
    }, { timezone: "Asia/Jakarta" });

    // polling BI Rate tiap N detik
    if (process.env.BI_RATE_POLL_ENABLED === "true") {
        const intervalSec = Number(process.env.BI_RATE_POLL_INTERVAL_SEC || 10);
        const intervalMs = Math.max(1, intervalSec) * 1000;
        let inFlight = false;

        console.log(`BI Rate polling enabled: every ${intervalSec}s`);

        setInterval(async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                console.log("Polling BI Rate...");
                await fetchBiRate();
                console.log("BI Rate polled");
            } catch (err) {
                console.error("BI Rate polling failed:", err.message);
            } finally {
                inFlight = false;
            }
        }, intervalMs);
    }

    // polling BI FX tiap N detik
    if (process.env.BI_FX_POLL_ENABLED === "true") {
        const intervalSec = Number(process.env.BI_FX_POLL_INTERVAL_SEC || 10);
        const intervalMs = Math.max(1, intervalSec) * 1000;
        let inFlight = false;

        console.log(`BI FX polling enabled: every ${intervalSec}s`);

        setInterval(async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                console.log("Polling BI FX...");
                await fetchBiFxCached();
                console.log("BI FX polled");
            } catch (err) {
                console.error("BI FX polling failed:", err.message);
            } finally {
                inFlight = false;
            }
        }, intervalMs);
    }

    // polling CNBC market data tiap N detik (default 10)
    if (process.env.CNBC_POLL_ENABLED === "true") {
        const intervalSec = Number(process.env.CNBC_POLL_INTERVAL_SEC || 10);
        const intervalMs = Math.max(1, intervalSec) * 1000;
        let inFlight = false;

        console.log(
            `CNBC polling enabled: every ${intervalSec}s (cache bypass)`
        );

        setInterval(async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                console.log("Polling CNBC market data...");
                await fetchInvestingMultipleCached({ bypassCache: true });
                console.log("CNBC market data updated");
            } catch (err) {
                console.error("CNBC polling failed:", err.message);
            } finally {
                inFlight = false;
            }
        }, intervalMs);
    }

    if (process.env.SIGNAL_POLL_ENABLED === "true") {
        const intervalSec = Number(process.env.SIGNAL_POLL_INTERVAL_SEC || 10);
        const intervalMs = Math.max(1, intervalSec) * 1000;
        const symbol = String(process.env.SIGNAL_SYMBOL || "XAUUSD").trim().toUpperCase();
        const profile = String(process.env.SIGNAL_SWISSQUOTE_PROFILE || "premium")
            .trim()
            .toLowerCase();
        let inFlight = false;

        console.log(`Signal polling enabled: ${symbol} every ${intervalSec}s`);

        setInterval(async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                console.log(`Polling signal quote ${symbol}...`);
                await collectSignalSnapshot({ symbol, profile });
                console.log(`Signal quote ${symbol} updated`);
            } catch (err) {
                console.error("Signal polling failed:", err.message);
            } finally {
                inFlight = false;
            }
        }, intervalMs);
    }
}

module.exports = { startCron };
