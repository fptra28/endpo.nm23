// routes/pricecharting.js
const express = require("express");
const { fetchPricechartingAscendedHeroes } = require("../services/pricechartingScraper");

const router = express.Router();

/**
 * GET /pricecharting/ascended-heroes
 * Optional: ?nocache=1
 */
router.get("/ascended-heroes", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const out = await fetchPricechartingAscendedHeroes({ bypassCache });

        res.json({
            source: out.source,
            fetched_at: out.fetched_at,
            cache: out.cache,
            count: out.count,
            data: Array.isArray(out.data)
                ? out.data.map((item) => ({
                    name: item.name,
                    image: item.image,
                    price_ungraded: item.price_ungraded,
                    price_grade_9: item.price_grade_9,
                    price_psa_10: item.price_psa_10,
                    currency: item.currency,
                }))
                : [],
        });
    } catch (e) {
        res.status(500).json({
            error: "Gagal ambil data PriceCharting",
            message: e.message,
        });
    }
});

module.exports = router;
