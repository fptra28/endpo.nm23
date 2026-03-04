// routes/ihsg.js
const express = require("express");
const { fetchIdxIndicesCached } = require("../services/idxIndicesScraper");

const router = express.Router();

router.get("/", async (req, res) => {
    try {
        const out = await fetchIdxIndicesCached();
        res.json(out);
    } catch (e) {
        res.status(500).json({
            error: "Gagal ambil IHSG/Indeks IDX",
            message: e.message,
        });
    }
});

module.exports = router;