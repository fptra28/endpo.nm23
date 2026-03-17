const express = require("express");
const { fetchAllRates } = require("../services/ratesAggregator");

const router = express.Router();

router.get("/", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const out = await fetchAllRates({ bypassCache });
        res.json(out);
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil semua rate",
            message: error.message,
            detail: error.detail || null,
        });
    }
});

module.exports = router;
