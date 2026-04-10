const express = require("express");
const {
    fetchJfxVolume,
    fetchJfxVolumeMeta, 
    fetchJfxVolumeRange,
} = require("../services/jfxVolume");

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
            meta: "/api/newsmaker-v2/jfx/volume/meta",
            year: "/api/newsmaker-v2/jfx/volume/year?year=2026",
            range: "/api/newsmaker-v2/jfx/volume/range?from=2026-01&to=2026-04",
        },
        defaults: {
            month: now.month,
            year: now.year,
        },
        tips: {
            no_cache: "Tambahkan `nocache=1` untuk bypass cache.",
            cache_policy:
                "Default: bulan lalu di-cache lama; bulan berjalan auto refresh per tanggal (Asia/Jakarta).",
        },
    });
});

router.get("/volume/meta", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const out = await fetchJfxVolumeMeta({ bypassCache });
        res.json(out);
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil metadata volume JFX",
            message: error.message,
            detail: error.detail || null,
        });
    }
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

router.get("/volume/year", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const force = String(req.query.force || "") === "1";
        const now = getJakartaMonthYearNow();

        const year = Number(req.query.year ?? req.query.tahun ?? now.year);
        const from = `${year}-01`;
        const to = `${year}-12`;

        const out = await fetchJfxVolumeRange({ from, to, bypassCache, force });
        res.json(out);
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil volume JFX per tahun",
            message: error.message,
            detail: error.detail || null,
        });
    }
});

router.get("/volume/range", async (req, res) => {
    try {
        const bypassCache = String(req.query.nocache || "") === "1";
        const force = String(req.query.force || "") === "1";

        const from = req.query.from;
        const to = req.query.to;

        const out = await fetchJfxVolumeRange({ from, to, bypassCache, force });
        res.json(out);
    } catch (error) {
        res.status(500).json({
            error: "Gagal ambil volume JFX range",
            message: error.message,
            detail: error.detail || null,
        });
    }
});

module.exports = router;
