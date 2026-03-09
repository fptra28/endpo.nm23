// routes/investing.js
const express = require("express");
const { fetchInvestingMultipleCached } = require("../services/investingBcaScraper");

const router = express.Router();

/**
 * GET /investing
 * Optional: ?nocache=1
 */
router.get("/", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const out = await fetchInvestingMultipleCached({ bypassCache });
        res.json({
            fetched_at: out.fetched_at,
            cache: out.cache,
            data: Array.isArray(out.data)
                ? out.data.map((item) => ({
                    symbol: item.symbol,
                    last: item.last,
                    change: item.change,
                    change_percent: item.change_percent,
                    currency: item.currency,
                }))
                : [],
        });
    } catch (e) {
        res.status(500).json({
            error: "Gagal ambil data Investing",
            message: e.message,
        });
    }
});

module.exports = router;
