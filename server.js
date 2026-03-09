// server.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cronRouter = require("./routes/cron");
const biRateRouter = require("./routes/biRate");
const fxRouter = require("./routes/fx");
const investingBcaRouter = require("./routes/investingBca");
const investingRouter = require("./routes/investing");

// ❌ jangan start cron di Vercel serverless
// const { startCron } = require("./services/cron");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const API_TOKEN = process.env.BI_RATE_API_TOKEN || "";

app.use(morgan("dev"));

app.use((req, res, next) => {
    if (req.path === "/") return next();

    if (!API_TOKEN) {
        return res.status(500).json({
            error: "Konfigurasi token belum diatur",
            message: "Set env BI_RATE_API_TOKEN",
        });
    }

    const auth = req.headers.authorization || "";
    const [type, token] = auth.split(" ");
    if (type !== "Bearer" || token !== API_TOKEN) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Bearer token tidak valid",
        });
    }
    return next();
});

// ✅ hanya jalankan cron kalau BUKAN environment serverless
if (process.env.ENABLE_CRON === "true") {
    const { startCron } = require("./services/cron");
    startCron();
}

app.get("/", (req, res) => res.send("Express server running"));

app.use("/api/newsmaker-v2/bi-rate", biRateRouter);
app.use("/api/newsmaker-v2/fx", fxRouter);
app.use("/api/newsmaker-v2/investing/bca", investingBcaRouter);
app.use("/api/newsmaker-v2/investing", investingRouter);
app.use("/cron", cronRouter);

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));

module.exports = app; // penting kalau nanti dipakai serverless handler
