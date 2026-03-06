const cron = require("node-cron");
const { fetchBiRate } = require("./scraper");

function startCron() {
    // jalan setiap hari jam 08:00 (Asia/Jakarta)
    cron.schedule("0 8 * * *", async () => {
        try {
            console.log("Running daily BI rate scraping...");
            await fetchBiRate();
            console.log("BI rate updated");
        } catch (err) {
            console.error("Cron scraping failed:", err.message);
        }
    }, { timezone: "Asia/Jakarta" });
}

module.exports = { startCron };
