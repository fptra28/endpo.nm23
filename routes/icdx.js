// routes/icdx.js
//
// Endpoint Express untuk data Press Release ICDX hasil scraping.
// Contoh pemakaian:
//   GET /api/newsmaker-v2/icdx/press-release             -> hasil AI dari berita terbaru
//   GET /api/newsmaker-v2/icdx/press-release/raw?limit=5 -> hasil scraper regex lama

const express = require("express");
const {
    fetchIcdxPressRelease,
    fetchLatestIcdxPressReleaseWithAi,
} = require("../services/icdxScraper");

const router = express.Router();

router.get("/", (req, res) => {
    res.json({
        ok: true,
        message: "ICDX routes ready. Pakai endpoint /press-release untuk data press release.",
        endpoints: {
            press_release: "/api/newsmaker-v2/icdx/press-release",
            raw: "/api/newsmaker-v2/icdx/press-release/raw?limit=5",
        },
        tips: {
            ai: "Set OPENAI_API_KEY dan opsional OPENAI_MODEL sebelum memakai endpoint utama.",
            raw: "Parameter limit dan nocache tersedia pada endpoint /press-release/raw.",
        },
    });
});

router.get("/press-release", async (req, res) => {
    try {
        res.json(await fetchLatestIcdxPressReleaseWithAi());
    } catch (error) {
        const configurationError = error.message.includes("OPENAI_API_KEY");
        res.status(configurationError ? 503 : 500).json({
            error: "Gagal mengambil data Press Release ICDX",
            message: error.message,
        });
    }
});

router.get("/press-release/raw", async (req, res) => {
    try {
        const out = await fetchIcdxPressRelease({
            limit: req.query.limit,
            bypassCache: String(req.query.nocache || "") === "1",
        });
        res.json(out);
    } catch (error) {
        res.status(500).json({
            error: "Gagal mengambil data mentah Press Release ICDX",
            message: error.message,
        });
    }
});

router.use((req, res) => {
    res.status(404).json({
        error: "Endpoint ICDX tidak ditemukan",
        message: "Cek path. Contoh: /api/newsmaker-v2/icdx/press-release",
        path: req.originalUrl,
        endpoints: {
            press_release: "/api/newsmaker-v2/icdx/press-release",
            raw: "/api/newsmaker-v2/icdx/press-release/raw?limit=5",
        },
    });
});

module.exports = router;
