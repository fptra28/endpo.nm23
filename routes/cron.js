const express = require("express");
const { fetchBiRate } = require("../services/scraper");
const { fetchBiFxCached } = require("../services/biFxScraper");
const { fetchJfxVolume } = require("../services/jfxVolume");

const router = express.Router();

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

router.get("/update-market", async (req, res) => {
    try {
        await fetchBiRate();
        await fetchBiFxCached();

        const now = getJakartaMonthYearNow();
        await fetchJfxVolume({ month: now.month, year: now.year });

        res.json({
            status: "success",
            message: "Market data updated",
            jfx: { month: now.month, year: now.year },
            time: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({
            error: "Cron failed",
            message: err.message
        });
    }
});

module.exports = router;
