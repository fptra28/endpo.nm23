// routes/investingBca.js
const express = require("express");
const { fetchInvestingBcaCached } = require("../services/investingBcaScraper");

const router = express.Router();

/**
 * GET /investing/bca
 * Optional: ?nocache=1
 */
router.get("/", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const out = await fetchInvestingBcaCached({ bypassCache });
        res.json({
            source: out.source,
            fetched_at: out.fetched_at,
            cache: out.cache,
            data: {
                symbol: out.symbol,
                last: out.last,
                change: out.change,
                change_percent: out.change_percent,
                currency: out.currency,
            },
        });
    } catch (e) {
        res.status(500).json({
            error: "Gagal ambil data BCA dari Investing",
            message: e.message,
        });
    }
});

module.exports = router;
