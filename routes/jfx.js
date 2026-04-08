const express = require("express");
const { fetchJfxVolume } = require("../services/jfxVolume");

const router = express.Router();

function getJakartaMonthYearNow() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
    }).formatToParts(new Date());

    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value);
    return { year, month };
}

router.get("/", (req, res) => {
    const now = getJakartaMonthYearNow();
    res.json({
        ok: true,
        message: "JFX routes ready. Pakai endpoint /volume untuk data volume.",
        endpoints: {
            volume: "/api/newsmaker-v2/jfx/volume?month=4&year=2026",
        },
        defaults: {
            month: now.month,
            year: now.year,
        },
        tips: {
            no_cache: "Tambahkan `nocache=1` untuk bypass cache.",
        },
    });
});

router.get("/volume", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const now = getJakartaMonthYearNow();

        const month = req.query.month ?? req.query.bulan ?? now.month;
        const year = req.query.year ?? req.query.tahun ?? now.year;

        const out = await fetchJfxVolume({ month, year, bypassCache });
        res.json(out);
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil volume JFX",
            message: error.message,
            detail: error.detail || null,
        });
    }
});

module.exports = router;
