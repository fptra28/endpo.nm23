// server.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cronRouter = require("./routes/cron");
const fxRouter = require("./routes/fx");
const investingBcaRouter = require("./routes/investingBca");
const investingRouter = require("./routes/investing");
const pricechartingRouter = require("./routes/pricecharting");
const ojkRegulasiRouter = require("./routes/ojkRegulasi");
const ratesRouter = require("./routes/rates");

// Jangan start cron di Vercel serverless
// const { startCron } = require("./services/cron");

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(morgan("dev"));

// Hanya jalankan cron kalau bukan environment serverless
if (process.env.ENABLE_CRON === "true") {
    const { startCron } = require("./services/cron");
    startCron();
}

app.get("/", (req, res) => res.send("Express server running"));

app.use("/api/newsmaker-v2/fx", fxRouter);
app.use("/api/newsmaker-v2/investing/bca", investingBcaRouter);
app.use("/api/newsmaker-v2/investing", investingRouter);
app.use("/api/newsmaker-v2/pricecharting", pricechartingRouter);
app.use("/api/newsmaker-v2/ojk", ojkRegulasiRouter);
app.use("/api/newsmaker-v2/rates", ratesRouter);
app.use("/cron", cronRouter);

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));

module.exports = app; // penting kalau nanti dipakai serverless handler
