const express = require("express");
const { fetchBappebtiRegulasi } = require("../services/bappebtiRegulasiScraper");

const router = express.Router();

async function handleFetch(req, res) {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const maxPagesRaw = Number(req.query.max_pages);
        const maxPages =
            Number.isFinite(maxPagesRaw) && maxPagesRaw > 0
                ? Math.floor(maxPagesRaw)
                : undefined;

        const out = await fetchBappebtiRegulasi({
            bypassCache,
            maxPages,
        });

        res.json({
            source: out.source,
            fetched_at: out.fetched_at,
            cache: out.cache,
            max_pages_per_category: out.max_pages_per_category,
            categories_count: out.categories_count,
            count: out.count,
            data: Array.isArray(out.data) ? out.data : [],
        });
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil data regulasi Bappebti",
            message: error.message,
        });
    }
}

router.get("/", handleFetch);
router.get("/regulasi", handleFetch);

module.exports = router;
