require("dotenv").config();

const { fetchLatestIcdxPressReleaseWithAi } = require("./icdxScraper");

const intervalSec = Math.max(
    60,
    Number(process.env.ICDX_AI_POLL_INTERVAL_SEC || 3600)
);

let inFlight = false;

async function scrape() {
    if (inFlight) return;
    inFlight = true;

    try {
        console.log("[ICDX worker] Scraping multiple Press Releases...");
        const result = await fetchLatestIcdxPressReleaseWithAi({
            bypassCache: true,
        });
        console.log(
            `[ICDX worker] Completed: ${result.count} row(s), fetched_at=${result.fetched_at}`
        );
    } catch (error) {
        console.error("[ICDX worker] Scraping failed:", error.message);
    } finally {
        inFlight = false;
    }
}

console.log(`[ICDX worker] Started; interval=${intervalSec}s`);
scrape();
setInterval(scrape, intervalSec * 1000);
