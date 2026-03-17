// routes/ojkRegulasi.js
const express = require("express");
const { fetchOjkRegulasi } = require("../services/ojkRegulasiScraper");

const router = express.Router();

/**
 * GET /ojk/regulasi
 * Optional: ?page=1 or ?max_pages=1 or ?nocache=1
 */
router.get("/regulasi", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const pageRaw = Number(req.query.page);
        const maxPagesRaw = Number(req.query.max_pages);
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
        const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.floor(maxPagesRaw) : 1;

        const out = await fetchOjkRegulasi({
            page,
            maxPages,
            bypassCache,
        });

        res.json({
            source: out.source,
            fetched_at: out.fetched_at,
            cache: out.cache,
            page: out.page,
            pages_fetched: out.pages_fetched,
            count: out.count,
            data: Array.isArray(out.data) ? out.data : [],
        });
    } catch (e) {
        res.status(500).json({
            error: "Gagal ambil data regulasi OJK",
            message: e.message,
        });
    }
});

module.exports = router;
