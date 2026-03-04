// routes/fx.js
const express = require("express");
const { fetchBiFxCached } = require("../services/biFxScraper");

const router = express.Router();

/**
 * GET /fx
 * - return semua kurs transaksi BI (jual/beli)
 * - optional query: ?q=USD (filter)
 */
router.get("/", async (req, res) => {
    try {
        const out = await fetchBiFxCached();

        const q = String(req.query.q || "").trim().toUpperCase();
        if (q) {
            const filtered = out.data.filter((x) =>
                String(x.currency).toUpperCase().includes(q)
            );
            return res.json({
                source: out.source,
                count: filtered.length,
                data: filtered,
                fetched_at: out.fetched_at,
                cache: out.cache,
            });
        }

        res.json(out);
    } catch (e) {
        res.status(500).json({ error: "Gagal ambil kurs BI", message: e.message });
    }
});

module.exports = router;