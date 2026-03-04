// server.js

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");

const { startCron } = require("./services/cron");

const biRateRouter = require("./routes/biRate");
const ihsgRouter = require("./routes/ihsg");
const fxRouter = require("./routes/fx");

const app = express();
const PORT = Number(process.env.PORT || 5000);

const API_TOKEN = process.env.BI_RATE_API_TOKEN || "";

app.use(morgan("dev"));

// Auth middleware (global)
app.use((req, res, next) => {
    // biar root route bisa dibuka tanpa token (opsional)
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

// cron (opsional: kalau cron kamu melakukan fetch untuk cache, aman taruh di sini)
startCron();

app.get("/api", (req, res) => {
    res.send("Express server running");
});

// routes
app.use("/api/bi-rate", biRateRouter);
app.use("/api/ihsg", ihsgRouter);
app.use("/api/fx", fxRouter);

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
