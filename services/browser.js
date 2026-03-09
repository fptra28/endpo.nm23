// services/browser.js
const chromium = require("@sparticuz/chromium");
const { chromium: pwChromium } = require("playwright-core");

function isServerlessEnv() {
    return (
        !!process.env.VERCEL ||
        !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
        !!process.env.NETLIFY ||
        !!process.env.RENDER
    );
}

async function getLaunchOptions() {
    if (isServerlessEnv()) {
        return {
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        };
    }

    const execPath =
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        process.env.CHROMIUM_PATH ||
        null;

    if (execPath) {
        return {
            executablePath: execPath,
            headless: true,
        };
    }

    // playwright-core but no executable path provided
    return {
        headless: true,
    };
}

async function launchChromium() {
    const options = await getLaunchOptions();
    try {
        return await pwChromium.launch(options);
    } catch (err) {
        if (!isServerlessEnv() && !options.executablePath) {
            throw new Error(
                "Chromium executable tidak ditemukan. Set PLAYWRIGHT_EXECUTABLE_PATH / CHROME_PATH " +
                    "atau install browser untuk Playwright."
            );
        }
        throw err;
    }
}

module.exports = { launchChromium };
