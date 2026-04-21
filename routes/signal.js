const express = require("express");
const { fetchSignalCached } = require("../services/signalService");

const router = express.Router();

router.get("/", async (req, res) => {
    try {
        const result = await fetchSignalCached({
            symbol: req.query.symbol,
            interval: req.query.interval,
            profile: req.query.profile,
        });

        res.json(result);
    } catch (error) {
        res.status(error.statusCode || 500).json({
            error: "Gagal ambil signal",
            message: error.message,
        });
    }
});

module.exports = router;
