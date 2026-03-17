const express = require("express");
const { fetchUsInterestRateCached } = require("../services/usInterestRateScraper");

const router = express.Router();

router.get("/", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const out = await fetchUsInterestRateCached({ bypassCache });

        res.json({
            source: out.source,
            fetched_at: out.fetched_at,
            cache: out.cache,
            data: {
                title: out.title,
                description: out.description,
                rate: out.rate,
                previous_rate: out.previous_rate,
                historical_high: out.historical_high,
                historical_low: out.historical_low,
                date_range: out.date_range,
                unit: out.unit,
                frequency: out.frequency,
                reference_period: out.reference_period,
                source_last_update: out.source_last_update,
                source_last_update_raw: out.source_last_update_raw,
            },
            calendar_count: out.calendar.length,
            calendar: out.calendar,
        });
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil suku bunga Amerika",
            message: error.message,
        });
    }
});

module.exports = router;
