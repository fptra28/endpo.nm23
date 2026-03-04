const express = require("express");
const { fetchBiRate } = require("../services/scraper");
const { fetchIdxIndicesCached } = require("../services/idxIndicesScraper");
const { fetchBiFxCached } = require("../services/biFxScraper");

const router = express.Router();

router.get("/update-market", async (req, res) => {
    try {
        await fetchBiRate();
        await fetchIdxIndicesCached();
        await fetchBiFxCached();

        res.json({
            status: "success",
            message: "Market data updated",
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