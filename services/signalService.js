const axios = require("axios");
const { getCache, setCache } = require("./cacheStore");

    const SWISSQUOTE_BASE_URL =
    "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument";
const REQUEST_TIMEOUT_MS = Number(process.env.SIGNAL_REQUEST_TIMEOUT_MS || 15000);
const MINUTE_HISTORY_LIMIT = Math.max(
    2000,
    Number(process.env.SIGNAL_HISTORY_LIMIT || 20000)
);
const MIN_CANDLES_REQUIRED = Math.max(
    200,
    Number(process.env.SIGNAL_MIN_POINTS || 200)
);
const DEFAULT_PROFILE = String(process.env.SIGNAL_SWISSQUOTE_PROFILE || "premium")
    .trim()
    .toLowerCase();

const minuteHistoryMemory = new Map();

function normalizeSymbol(symbol) {
    const raw = String(symbol || process.env.SIGNAL_SYMBOL || "XAUUSD")
        .trim()
        .toUpperCase();
    const compact = raw.replace(/[^A-Z]/g, "");

    if (!/^[A-Z]{6}$/.test(compact)) {
        const error = new Error("Symbol harus format 6 huruf, misalnya XAUUSD atau EURUSD.");
        error.statusCode = 400;
        throw error;
    }

    return {
        symbol: compact,
        fromSymbol: compact.slice(0, 3),
        toSymbol: compact.slice(3, 6),
    };
}

function normalizeInterval(interval) {
    const value = String(interval || "15min").trim().toLowerCase();
    const allowed = new Set(["1min", "5min", "15min", "30min", "60min"]);

    if (!allowed.has(value)) {
        const error = new Error("Interval tidak valid. Gunakan 1min, 5min, 15min, 30min, atau 60min.");
        error.statusCode = 400;
        throw error;
    }

    return value;
}

function normalizeProfile(profile) {
    const value = String(profile || DEFAULT_PROFILE).trim().toLowerCase();
    return value || "premium";
}

function buildHistoryCacheKey(symbol) {
    return `signal_history:${symbol}`;
}

function intervalToMinutes(interval) {
    const mapping = {
        "1min": 1,
        "5min": 5,
        "15min": 15,
        "30min": 30,
        "60min": 60,
    };

    return mapping[interval] || 15;
}

function formatNumber(value, digits = 4) {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(digits));
}

function resolveTimestampMs(value) {
    if (Number.isFinite(value)) return Number(value);

    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;

    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMinuteCandle(raw) {
    if (!raw || typeof raw !== "object") return null;

    const open = Number(raw.open ?? raw.mid ?? raw.close);
    const high = Number(raw.high ?? raw.ask ?? raw.mid ?? raw.close);
    const low = Number(raw.low ?? raw.bid ?? raw.mid ?? raw.close);
    const close = Number(raw.close ?? raw.mid);

    if (![open, high, low, close].every((value) => Number.isFinite(value))) {
        return null;
    }

    const sourceTs = resolveTimestampMs(raw.bucketTs ?? raw.ts ?? raw.timestamp ?? raw.updatedAt);
    if (!Number.isFinite(sourceTs)) {
        return null;
    }

    const bucketTs = Math.floor(sourceTs / 60000) * 60000;

    return {
        bucketTs,
        timestamp: new Date(bucketTs).toISOString(),
        updatedAt: new Date(sourceTs).toISOString(),
        open,
        high,
        low,
        close,
        bid: Number.isFinite(Number(raw.bid)) ? Number(raw.bid) : close,
        ask: Number.isFinite(Number(raw.ask)) ? Number(raw.ask) : close,
        spread: Number.isFinite(Number(raw.spread)) ? Number(raw.spread) : null,
        tickVolume: Math.max(1, Number(raw.tickVolume) || 1),
        spreadProfile: raw.spreadProfile || null,
        topo: raw.topo || null,
    };
}

function sanitizeMinuteCandles(items) {
    if (!Array.isArray(items)) return [];

    const ordered = items
        .map(normalizeMinuteCandle)
        .filter(Boolean)
        .sort((a, b) => a.bucketTs - b.bucketTs);

    const deduped = [];

    for (const candle of ordered) {
        const last = deduped[deduped.length - 1];

        if (last && last.bucketTs === candle.bucketTs) {
            last.high = Math.max(last.high, candle.high);
            last.low = Math.min(last.low, candle.low);
            last.close = candle.close;
            last.ask = candle.ask;
            last.bid = candle.bid;
            last.spread = candle.spread;
            last.tickVolume = (Number(last.tickVolume) || 1) + (Number(candle.tickVolume) || 1);
            last.updatedAt = candle.updatedAt;
            continue;
        }

        deduped.push(candle);
    }

    return deduped.slice(-MINUTE_HISTORY_LIMIT);
}

function sma(values, period) {
    if (values.length < period) return null;
    const window = values.slice(values.length - period);
    return window.reduce((sum, value) => sum + value, 0) / period;
}

function wma(values, period) {
    if (values.length < period) return null;

    const window = values.slice(values.length - period);
    const denominator = (period * (period + 1)) / 2;
    const weightedSum = window.reduce(
        (total, value, index) => total + (value * (index + 1)),
        0
    );

    return weightedSum / denominator;
}

function sum(values, period) {
    if (values.length < period) return null;
    return values.slice(values.length - period).reduce((acc, value) => acc + value, 0);
}

function stddev(values, period) {
    if (values.length < period) return null;
    const window = values.slice(values.length - period);
    const mean = sma(values, period);
    const variance =
        window.reduce((total, value) => total + (value - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
}

function emaSeries(values, period) {
    if (values.length < period) return [];

    const result = Array(values.length).fill(null);
    const multiplier = 2 / (period + 1);
    let previous = values.slice(0, period).reduce((sumValue, value) => sumValue + value, 0) / period;

    result[period - 1] = previous;

    for (let index = period; index < values.length; index += 1) {
        previous = (values[index] - previous) * multiplier + previous;
        result[index] = previous;
    }

    return result;
}

function ema(values, period) {
    const series = emaSeries(values, period);
    return series.length ? series[series.length - 1] : null;
}

function hma(values, period) {
    if (values.length < period) return null;

    const halfPeriod = Math.max(1, Math.floor(period / 2));
    const sqrtPeriod = Math.max(1, Math.round(Math.sqrt(period)));
    const diffSeries = [];

    for (let index = period - 1; index < values.length; index += 1) {
        const prefix = values.slice(0, index + 1);
        const fullWma = wma(prefix, period);
        const halfWma = wma(prefix, halfPeriod);

        if (!Number.isFinite(fullWma) || !Number.isFinite(halfWma)) continue;
        diffSeries.push((2 * halfWma) - fullWma);
    }

    return wma(diffSeries, sqrtPeriod);
}

function vwma(values, volumes, period) {
    if (values.length < period || volumes.length < period) return null;

    const priceWindow = values.slice(values.length - period);
    const volumeWindow = volumes.slice(volumes.length - period);
    const totalVolume = volumeWindow.reduce((total, value) => total + value, 0);

    if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;

    const weightedTotal = priceWindow.reduce(
        (total, price, index) => total + (price * volumeWindow[index]),
        0
    );

    return weightedTotal / totalVolume;
}

function rsiSeries(values, period = 14) {
    if (values.length <= period) return [];

    const series = Array(values.length).fill(null);
    let gains = 0;
    let losses = 0;

    for (let index = 1; index <= period; index += 1) {
        const delta = values[index] - values[index - 1];
        if (delta >= 0) gains += delta;
        else losses += Math.abs(delta);
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    series[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

    for (let index = period + 1; index < values.length; index += 1) {
        const delta = values[index] - values[index - 1];
        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? Math.abs(delta) : 0;

        averageGain = (averageGain * (period - 1) + gain) / period;
        averageLoss = (averageLoss * (period - 1) + loss) / period;

        series[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
    }

    return series;
}

function rsi(values, period = 14) {
    const series = rsiSeries(values, period);
    return series.length ? series[series.length - 1] : null;
}

function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const fastSeries = emaSeries(values, fastPeriod);
    const slowSeries = emaSeries(values, slowPeriod);

    if (!fastSeries.length || !slowSeries.length) return null;

    const macdValues = [];

    for (let index = 0; index < values.length; index += 1) {
        if (fastSeries[index] === null || slowSeries[index] === null) continue;
        macdValues.push(fastSeries[index] - slowSeries[index]);
    }

    if (macdValues.length < signalPeriod) return null;

    const signalSeries = emaSeries(macdValues, signalPeriod);
    const lastMacd = macdValues[macdValues.length - 1] ?? null;
    const lastSignal = signalSeries[signalSeries.length - 1] ?? null;

    if (!Number.isFinite(lastMacd) || !Number.isFinite(lastSignal)) return null;

    return {
        MACD: lastMacd,
        signal: lastSignal,
        histogram: lastMacd - lastSignal,
    };
}

function stochastic(highs, lows, closes, period = 14, signalPeriod = 3) {
    if (closes.length < period || highs.length < period || lows.length < period) return null;

    const kSeries = [];

    for (let index = period - 1; index < closes.length; index += 1) {
        const highWindow = highs.slice(index - period + 1, index + 1);
        const lowWindow = lows.slice(index - period + 1, index + 1);
        const highestHigh = Math.max(...highWindow);
        const lowestLow = Math.min(...lowWindow);
        const denominator = highestHigh - lowestLow;
        const value = denominator === 0 ? 0 : ((closes[index] - lowestLow) / denominator) * 100;
        kSeries.push(value);
    }

    if (kSeries.length < signalPeriod) return null;

    const k = kSeries[kSeries.length - 1];
    const d =
        kSeries.slice(kSeries.length - signalPeriod).reduce((total, value) => total + value, 0) /
        signalPeriod;

    return { k, d };
}

function cci(highs, lows, closes, period = 20) {
    if (closes.length < period || highs.length < period || lows.length < period) return null;

    const typicalPrices = closes.map((close, index) => (highs[index] + lows[index] + close) / 3);
    const window = typicalPrices.slice(typicalPrices.length - period);
    const mean = window.reduce((total, value) => total + value, 0) / period;
    const meanDeviation =
        window.reduce((total, value) => total + Math.abs(value - mean), 0) / period;

    if (meanDeviation === 0) return 0;

    return (window[window.length - 1] - mean) / (0.015 * meanDeviation);
}

function williamsR(highs, lows, closes, period = 14) {
    if (closes.length < period || highs.length < period || lows.length < period) return null;

    const highWindow = highs.slice(highs.length - period);
    const lowWindow = lows.slice(lows.length - period);
    const highestHigh = Math.max(...highWindow);
    const lowestLow = Math.min(...lowWindow);
    const denominator = highestHigh - lowestLow;

    if (denominator === 0) return 0;

    return ((highestHigh - closes[closes.length - 1]) / denominator) * -100;
}

function momentum(values, period = 10) {
    if (values.length <= period) return null;
    return values[values.length - 1] - values[values.length - 1 - period];
}

function medianPrices(highs, lows) {
    return highs.map((high, index) => (high + lows[index]) / 2);
}

function awesomeOscillator(highs, lows) {
    const medians = medianPrices(highs, lows);
    const sma5 = sma(medians, 5);
    const sma34 = sma(medians, 34);

    if (!Number.isFinite(sma5) || !Number.isFinite(sma34)) return null;
    return sma5 - sma34;
}

function stochasticRsi(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
    const rsiValues = rsiSeries(closes, rsiPeriod).filter((value) => Number.isFinite(value));
    if (rsiValues.length < stochPeriod) return null;

    const rawSeries = [];

    for (let index = stochPeriod - 1; index < rsiValues.length; index += 1) {
        const window = rsiValues.slice(index - stochPeriod + 1, index + 1);
        const highest = Math.max(...window);
        const lowest = Math.min(...window);
        const denominator = highest - lowest;
        const raw = denominator === 0 ? 0 : ((rsiValues[index] - lowest) / denominator) * 100;
        rawSeries.push(raw);
    }

    if (rawSeries.length < smoothK) return null;

    const kSeries = [];
    for (let index = smoothK - 1; index < rawSeries.length; index += 1) {
        const window = rawSeries.slice(index - smoothK + 1, index + 1);
        kSeries.push(window.reduce((total, value) => total + value, 0) / smoothK);
    }

    if (kSeries.length < smoothD) return null;

    const k = kSeries[kSeries.length - 1];
    const d =
        kSeries.slice(kSeries.length - smoothD).reduce((total, value) => total + value, 0) /
        smoothD;

    return { k, d };
}

function adx(highs, lows, closes, period = 14) {
    if (highs.length <= period * 2 || lows.length <= period * 2 || closes.length <= period * 2) {
        return null;
    }

    const trList = [];
    const plusDmList = [];
    const minusDmList = [];

    for (let index = 1; index < highs.length; index += 1) {
        const highDiff = highs[index] - highs[index - 1];
        const lowDiff = lows[index - 1] - lows[index];
        const trueRange = Math.max(
            highs[index] - lows[index],
            Math.abs(highs[index] - closes[index - 1]),
            Math.abs(lows[index] - closes[index - 1])
        );

        trList.push(trueRange);
        plusDmList.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
        minusDmList.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    }

    let trSmooth = trList.slice(0, period).reduce((total, value) => total + value, 0);
    let plusDmSmooth = plusDmList.slice(0, period).reduce((total, value) => total + value, 0);
    let minusDmSmooth = minusDmList.slice(0, period).reduce((total, value) => total + value, 0);

    const dxValues = [];
    let plusDiLast = null;
    let minusDiLast = null;

    for (let index = period; index < trList.length; index += 1) {
        if (index > period) {
            trSmooth = trSmooth - trSmooth / period + trList[index];
            plusDmSmooth = plusDmSmooth - plusDmSmooth / period + plusDmList[index];
            minusDmSmooth = minusDmSmooth - minusDmSmooth / period + minusDmList[index];
        }

        if (trSmooth === 0) continue;

        const plusDi = (plusDmSmooth / trSmooth) * 100;
        const minusDi = (minusDmSmooth / trSmooth) * 100;
        const denominator = plusDi + minusDi;
        const dx = denominator === 0 ? 0 : (Math.abs(plusDi - minusDi) / denominator) * 100;

        plusDiLast = plusDi;
        minusDiLast = minusDi;
        dxValues.push(dx);
    }

    if (dxValues.length < period) return null;

    let adxValue = dxValues.slice(0, period).reduce((total, value) => total + value, 0) / period;
    for (let index = period; index < dxValues.length; index += 1) {
        adxValue = ((adxValue * (period - 1)) + dxValues[index]) / period;
    }

    return {
        adx: adxValue,
        plusDi: plusDiLast,
        minusDi: minusDiLast,
    };
}

function bullBearPower(highs, lows, closes, period = 13) {
    const emaValue = ema(closes, period);
    if (!Number.isFinite(emaValue)) return null;

    return {
        bull: highs[highs.length - 1] - emaValue,
        bear: lows[lows.length - 1] - emaValue,
        ema: emaValue,
    };
}

function ultimateOscillator(highs, lows, closes) {
    if (highs.length < 29 || lows.length < 29 || closes.length < 29) return null;

    const buyingPressure = [];
    const trueRange = [];

    for (let index = 1; index < closes.length; index += 1) {
        const prevClose = closes[index - 1];
        const minLow = Math.min(lows[index], prevClose);
        const maxHigh = Math.max(highs[index], prevClose);

        buyingPressure.push(closes[index] - minLow);
        trueRange.push(maxHigh - minLow);
    }

    const avg7bp = sum(buyingPressure, 7);
    const avg7tr = sum(trueRange, 7);
    const avg14bp = sum(buyingPressure, 14);
    const avg14tr = sum(trueRange, 14);
    const avg28bp = sum(buyingPressure, 28);
    const avg28tr = sum(trueRange, 28);

    if (
        !Number.isFinite(avg7bp) || !Number.isFinite(avg7tr) || avg7tr === 0 ||
        !Number.isFinite(avg14bp) || !Number.isFinite(avg14tr) || avg14tr === 0 ||
        !Number.isFinite(avg28bp) || !Number.isFinite(avg28tr) || avg28tr === 0
    ) {
        return null;
    }

    const average7 = avg7bp / avg7tr;
    const average14 = avg14bp / avg14tr;
    const average28 = avg28bp / avg28tr;

    return 100 * ((4 * average7) + (2 * average14) + average28) / 7;
}

function ichimokuCloud(highs, lows, conversionPeriod = 9, basePeriod = 26, spanBPeriod = 52) {
    if (highs.length < spanBPeriod || lows.length < spanBPeriod) {
        return null;
    }

    const conversionHigh = Math.max(...highs.slice(highs.length - conversionPeriod));
    const conversionLow = Math.min(...lows.slice(lows.length - conversionPeriod));
    const baseHigh = Math.max(...highs.slice(highs.length - basePeriod));
    const baseLow = Math.min(...lows.slice(lows.length - basePeriod));
    const spanBHigh = Math.max(...highs.slice(highs.length - spanBPeriod));
    const spanBLow = Math.min(...lows.slice(lows.length - spanBPeriod));

    const conversionLine = (conversionHigh + conversionLow) / 2;
    const baseLine = (baseHigh + baseLow) / 2;
    const leadingSpanA = (conversionLine + baseLine) / 2;
    const leadingSpanB = (spanBHigh + spanBLow) / 2;

    return {
        conversionLine,
        baseLine,
        leadingSpanA,
        leadingSpanB,
    };
}

function resolveOscillatorSignal(value, type) {
    if (!Number.isFinite(value)) return "NEUTRAL";

    switch (type) {
        case "RSI":
            if (value < 30) return "BUY";
            if (value > 70) return "SELL";
            return "NEUTRAL";
        case "CCI":
            if (value < -100) return "BUY";
            if (value > 100) return "SELL";
            return "NEUTRAL";
        case "WILLR":
            if (value < -80) return "BUY";
            if (value > -20) return "SELL";
            return "NEUTRAL";
        case "STOCH":
            if (value < 20) return "BUY";
            if (value > 80) return "SELL";
            return "NEUTRAL";
        case "UO":
            if (value > 70) return "BUY";
            if (value < 30) return "SELL";
            return "NEUTRAL";
        default:
            return "NEUTRAL";
    }
}

function resolveMovingAverageSignal(price, movingAverage) {
    if (!Number.isFinite(price) || !Number.isFinite(movingAverage)) return "NEUTRAL";
    if (price > movingAverage) return "BUY";
    if (price < movingAverage) return "SELL";
    return "NEUTRAL";
}

function resolveSummary(votes, total) {
    if (total === 0) return "NEUTRAL";

    const score = (votes.buy - votes.sell) / total;

    if (score <= -0.5) return "STRONG SELL";
    if (score < -0.1) return "SELL";
    if (score <= 0.1) return "NEUTRAL";
    if (score <= 0.5) return "BUY";
    return "STRONG BUY";
}

function tallyVotes(indicators) {
    return indicators.reduce(
        (accumulator, indicator) => {
            if (indicator.signal === "BUY") accumulator.buy += 1;
            else if (indicator.signal === "SELL") accumulator.sell += 1;
            else accumulator.neutral += 1;
            return accumulator;
        },
        { buy: 0, sell: 0, neutral: 0 }
    );
}

function buildIndicatorSections({
    summary,
    detail,
    totalIndicators,
    oscillatorSummary,
    movingAverageSummary,
    oscillatorIndicators = [],
    movingAverageIndicators = [],
}) {
    return {
        summary: {
            label: "Summary",
            summary,
            detail,
            total: totalIndicators,
        },
        oscillators: {
            label: "Oscillators",
            summary: oscillatorSummary.summary,
            detail: oscillatorSummary.detail,
            total: oscillatorSummary.total,
            indicators: oscillatorIndicators,
        },
        movingAverages: {
            label: "Moving Averages",
            summary: movingAverageSummary.summary,
            detail: movingAverageSummary.detail,
            total: movingAverageSummary.total,
            indicators: movingAverageIndicators,
        },
    };
}

function formatActionLabel(signal) {
    const normalized = String(signal || "NEUTRAL").toUpperCase();

    if (normalized === "BUY") return "Buy";
    if (normalized === "SELL") return "Sell";
    return "Neutral";
}

async function loadMinuteHistory(symbol) {
    const key = buildHistoryCacheKey(symbol);

    if (minuteHistoryMemory.has(key)) {
        return minuteHistoryMemory.get(key);
    }

    try {
        const cached = await getCache(key);
        const candles = Array.isArray(cached?.payload?.minuteCandles)
            ? sanitizeMinuteCandles(cached.payload.minuteCandles)
            : Array.isArray(cached?.payload?.samples)
                ? sanitizeMinuteCandles(cached.payload.samples)
                : [];

        minuteHistoryMemory.set(key, candles);
        return candles;
    } catch (error) {
        console.error("Gagal membaca history signal:", error.message);
        return [];
    }
}

async function saveMinuteHistory(symbol, minuteCandles) {
    const key = buildHistoryCacheKey(symbol);
    minuteHistoryMemory.set(key, minuteCandles);

    try {
        await setCache(
            key,
            {
                symbol,
                minuteCandles,
            },
            new Date().toISOString()
        );
    } catch (error) {
        console.error("Gagal menyimpan history signal:", error.message);
    }
}

function chooseQuote(records, preferredProfile) {
    const flattened = [];

    for (const record of records) {
        const prices = Array.isArray(record?.spreadProfilePrices) ? record.spreadProfilePrices : [];
        for (const price of prices) {
            flattened.push({
                ts: Number(record.ts),
                topo: record.topo || null,
                spreadProfile: String(price.spreadProfile || "").toLowerCase(),
                bid: Number(price.bid),
                ask: Number(price.ask),
                bidSpread: Number(price.bidSpread),
                askSpread: Number(price.askSpread),
            });
        }
    }

    const valid = flattened.filter(
        (item) => Number.isFinite(item.bid) && Number.isFinite(item.ask) && item.bid > 0 && item.ask > 0
    );

    if (!valid.length) return null;

    const exactMatch = valid.find((item) => item.spreadProfile === preferredProfile);
    if (exactMatch) return exactMatch;

    const premiumMatch = valid.find((item) => item.spreadProfile === "premium");
    if (premiumMatch) return premiumMatch;

    return valid[0];
}

async function fetchSwissquoteQuote({ symbol, profile }) {
    const url = `${SWISSQUOTE_BASE_URL}/${symbol.fromSymbol}/${symbol.toSymbol}`;
    const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
    });

    if (!Array.isArray(response.data) || !response.data.length) {
        const error = new Error("Response Swissquote kosong atau tidak valid.");
        error.statusCode = 502;
        throw error;
    }

    const selected = chooseQuote(response.data, profile);
    if (!selected) {
        const error = new Error("Quote Swissquote tidak mengandung bid/ask yang valid.");
        error.statusCode = 502;
        throw error;
    }

    const mid = (selected.bid + selected.ask) / 2;

    return {
        ts: selected.ts,
        timestamp: new Date(selected.ts).toISOString(),
        bid: selected.bid,
        ask: selected.ask,
        mid,
        spread: selected.ask - selected.bid,
        spreadProfile: selected.spreadProfile,
        bidSpread: selected.bidSpread,
        askSpread: selected.askSpread,
        topo: selected.topo,
    };
}

function upsertMinuteCandle(minuteCandles, quote) {
    const bucketTs = Math.floor(quote.ts / 60000) * 60000;
    const last = minuteCandles[minuteCandles.length - 1];

    if (last && Number(last.bucketTs) === bucketTs) {
        last.high = Math.max(last.high, quote.ask, quote.mid);
        last.low = Math.min(last.low, quote.bid, quote.mid);
        last.close = quote.mid;
        last.ask = quote.ask;
        last.bid = quote.bid;
        last.spread = quote.spread;
        last.tickVolume = (Number(last.tickVolume) || 1) + 1;
        last.updatedAt = quote.timestamp;
        return minuteCandles;
    }

    minuteCandles.push({
        bucketTs,
        timestamp: new Date(bucketTs).toISOString(),
        updatedAt: quote.timestamp,
        open: quote.mid,
        high: Math.max(quote.ask, quote.mid),
        low: Math.min(quote.bid, quote.mid),
        close: quote.mid,
        bid: quote.bid,
        ask: quote.ask,
        spread: quote.spread,
        tickVolume: 1,
        spreadProfile: quote.spreadProfile,
        topo: quote.topo,
    });

    return minuteCandles;
}

function aggregateCandles(minuteCandles, interval) {
    const sizeMinutes = intervalToMinutes(interval);
    if (sizeMinutes === 1) return minuteCandles;

    const bucketMap = new Map();

    for (const candle of minuteCandles) {
        const bucketTs = Math.floor(Number(candle.bucketTs) / (sizeMinutes * 60000)) * sizeMinutes * 60000;
        const existing = bucketMap.get(bucketTs);

        if (!existing) {
            bucketMap.set(bucketTs, {
                bucketTs,
                timestamp: new Date(bucketTs).toISOString(),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                tickVolume: Number(candle.tickVolume) || 1,
            });
            continue;
        }

        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
        existing.tickVolume += Number(candle.tickVolume) || 1;
    }

    return Array.from(bucketMap.values()).sort((a, b) => a.bucketTs - b.bucketTs);
}

async function collectSignalSnapshot({ symbol, profile } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedProfile = normalizeProfile(profile);
    const quote = await fetchSwissquoteQuote({
        symbol: normalizedSymbol,
        profile: normalizedProfile,
    });

    const minuteCandles = await loadMinuteHistory(normalizedSymbol.symbol);
    const nextCandles = Array.isArray(minuteCandles) ? [...minuteCandles] : [];

    upsertMinuteCandle(nextCandles, quote);

    const trimmed = nextCandles.slice(-MINUTE_HISTORY_LIMIT);
    await saveMinuteHistory(normalizedSymbol.symbol, trimmed);

    return {
        symbol: normalizedSymbol.symbol,
        quote,
        minuteCandles: trimmed,
    };
}

function buildWarmupPayload({ symbol, interval, quote, minuteCandles, candles }) {
    const emptyVotes = {
        buy: 0,
        sell: 0,
        neutral: 0,
    };

    return {
        status: "WARMING_UP",
        summary: "NEUTRAL",
        detail: emptyVotes,
        totalIndicators: 0,
        symbol,
        requestedInterval: interval,
        effectiveInterval: interval,
        source: "Swissquote",
        sourceFunction: "public-quotes/bboquotes",
        price: formatNumber(quote.mid, 4),
        bid: formatNumber(quote.bid, 4),
        ask: formatNumber(quote.ask, 4),
        spread: formatNumber(quote.spread, 4),
        spreadProfile: quote.spreadProfile,
        topo: quote.topo,
        latestCandleAt: candles[candles.length - 1]?.timestamp || quote.timestamp,
        fetched_at: new Date().toISOString(),
        minuteHistoryPoints: minuteCandles.length,
        aggregatedCandles: candles.length,
        minCandlesRequired: MIN_CANDLES_REQUIRED,
        oscillatorSummary: {
            summary: "NEUTRAL",
            detail: emptyVotes,
            total: 0,
        },
        movingAverageSummary: {
            summary: "NEUTRAL",
            detail: emptyVotes,
            total: 0,
        },
        indicatorSections: buildIndicatorSections({
            summary: "NEUTRAL",
            detail: emptyVotes,
            totalIndicators: 0,
            oscillatorSummary: {
                summary: "NEUTRAL",
                detail: emptyVotes,
                total: 0,
            },
            movingAverageSummary: {
                summary: "NEUTRAL",
                detail: emptyVotes,
                total: 0,
            },
        }),
        indicators: [],
        note: "Akurasi sebelumnya meleset karena memakai snapshot tick mentah. Sekarang data diagregasi dulu jadi candle per interval, tapi tetap belum akan identik 100% dengan feed TradingView/OANDA.",
    };
}

function buildIndicatorPayload({ symbol, interval, minuteCandles, candles, quote }) {
    if (candles.length < MIN_CANDLES_REQUIRED) {
        return buildWarmupPayload({
            symbol,
            interval,
            quote,
            minuteCandles,
            candles,
        });
    }

    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const volumes = candles.map((candle) => Number(candle.tickVolume) || 1);
    const price = closes[closes.length - 1];

    const rsi14 = rsi(closes, 14);
    const stoch14 = stochastic(highs, lows, closes, 14, 3);
    const cci20 = cci(highs, lows, closes, 20);
    const adx14 = adx(highs, lows, closes, 14);
    const ao = awesomeOscillator(highs, lows);
    const momentum10 = momentum(closes, 10);
    const macdValue = macd(closes, 12, 26, 9);
    const stochRsiValue = stochasticRsi(closes, 14, 14, 3, 3);
    const willr14 = williamsR(highs, lows, closes, 14);
    const bullBear = bullBearPower(highs, lows, closes, 13);
    const uo = ultimateOscillator(highs, lows, closes);

    const ema10 = ema(closes, 10);
    const sma10 = sma(closes, 10);
    const ema20 = ema(closes, 20);
    const sma20 = sma(closes, 20);
    const ema30 = ema(closes, 30);
    const sma30 = sma(closes, 30);
    const ema50 = ema(closes, 50);
    const sma50 = sma(closes, 50);
    const ema100 = ema(closes, 100);
    const sma100 = sma(closes, 100);
    const ema200 = ema(closes, 200);
    const sma200 = sma(closes, 200);
    const hma9 = hma(closes, 9);
    const vwma20 = vwma(closes, volumes, 20);
    const ichimoku = ichimokuCloud(highs, lows, 9, 26, 52);

    const indicators = [];

    {
        const signal = resolveOscillatorSignal(rsi14, "RSI");
        indicators.push({
            name: "Relative Strength Index (14)",
            indicator: "Relative Strength Index (14)",
            group: "oscillator",
            value: formatNumber(rsi14, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveOscillatorSignal(stoch14?.k, "STOCH");
        indicators.push({
            name: "Stochastic %K (14, 3, 3)",
            indicator: "Stochastic %K (14, 3, 3)",
            group: "oscillator",
            value: formatNumber(stoch14?.k, 3),
            signal,
            action: formatActionLabel(signal),
            components: stoch14
                ? {
                    k: formatNumber(stoch14.k, 3),
                    d: formatNumber(stoch14.d, 3),
                }
                : null,
        });
    }
    {
        const signal = resolveOscillatorSignal(cci20, "CCI");
        indicators.push({
            name: "Commodity Channel Index (20)",
            indicator: "Commodity Channel Index (20)",
            group: "oscillator",
            value: formatNumber(cci20, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal =
            !adx14 || !Number.isFinite(adx14.adx)
                ? "NEUTRAL"
                : adx14.adx < 20
                    ? "NEUTRAL"
                    : adx14.plusDi > adx14.minusDi
                        ? "BUY"
                        : "SELL";
        indicators.push({
            name: "Average Directional Index (14)",
            indicator: "Average Directional Index (14)",
            group: "oscillator",
            value: formatNumber(adx14?.adx, 3),
            signal,
            action: formatActionLabel(signal),
            components: adx14
                ? {
                    adx: formatNumber(adx14.adx, 3),
                    plusDi: formatNumber(adx14.plusDi, 3),
                    minusDi: formatNumber(adx14.minusDi, 3),
                }
                : null,
        });
    }
    {
        const signal =
            !Number.isFinite(ao)
                ? "NEUTRAL"
                : ao > 0
                    ? "BUY"
                    : ao < 0
                        ? "SELL"
                        : "NEUTRAL";
        indicators.push({
            name: "Awesome Oscillator",
            indicator: "Awesome Oscillator",
            group: "oscillator",
            value: formatNumber(ao, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal =
            !Number.isFinite(momentum10)
                ? "NEUTRAL"
                : momentum10 > 0
                    ? "BUY"
                    : momentum10 < 0
                        ? "SELL"
                        : "NEUTRAL";
        indicators.push({
            name: "Momentum (10)",
            indicator: "Momentum (10)",
            group: "oscillator",
            value: formatNumber(momentum10, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal =
            !macdValue
                ? "NEUTRAL"
                : macdValue.MACD > macdValue.signal
                    ? "BUY"
                    : macdValue.MACD < macdValue.signal
                        ? "SELL"
                        : "NEUTRAL";
        indicators.push({
            name: "MACD Level (12, 26)",
            indicator: "MACD Level (12, 26)",
            group: "oscillator",
            value: formatNumber(macdValue?.MACD, 3),
            signal,
            action: formatActionLabel(signal),
            components: macdValue
                ? {
                    macd: formatNumber(macdValue.MACD, 3),
                    signal: formatNumber(macdValue.signal, 3),
                    histogram: formatNumber(macdValue.histogram, 3),
                }
                : null,
        });
    }
    {
        const signal = resolveOscillatorSignal(stochRsiValue?.k, "STOCH");
        indicators.push({
            name: "Stochastic RSI Fast (3, 3, 14, 14)",
            indicator: "Stochastic RSI Fast (3, 3, 14, 14)",
            group: "oscillator",
            value: formatNumber(stochRsiValue?.k, 3),
            signal,
            action: formatActionLabel(signal),
            components: stochRsiValue
                ? {
                    k: formatNumber(stochRsiValue.k, 3),
                    d: formatNumber(stochRsiValue.d, 3),
                }
                : null,
        });
    }
    {
        const signal = resolveOscillatorSignal(willr14, "WILLR");
        indicators.push({
            name: "Williams Percent Range (14)",
            indicator: "Williams Percent Range (14)",
            group: "oscillator",
            value: formatNumber(willr14, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal =
            !bullBear
                ? "NEUTRAL"
                : bullBear.bull > 0 && bullBear.bear > 0
                    ? "BUY"
                    : bullBear.bull < 0 && bullBear.bear < 0
                        ? "SELL"
                        : "NEUTRAL";
        indicators.push({
            name: "Bull Bear Power",
            indicator: "Bull Bear Power",
            group: "oscillator",
            value: formatNumber(bullBear?.bull, 3),
            signal,
            action: formatActionLabel(signal),
            components: bullBear
                ? {
                    bull: formatNumber(bullBear.bull, 3),
                    bear: formatNumber(bullBear.bear, 3),
                    ema13: formatNumber(bullBear.ema, 3),
                }
                : null,
        });
    }
    {
        const signal = resolveOscillatorSignal(uo, "UO");
        indicators.push({
            name: "Ultimate Oscillator (7, 14, 28)",
            indicator: "Ultimate Oscillator (7, 14, 28)",
            group: "oscillator",
            value: formatNumber(uo, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }

    {
        const signal = resolveMovingAverageSignal(price, ema10);
        indicators.push({
            name: "Exponential Moving Average (10)",
            indicator: "Exponential Moving Average (10)",
            group: "moving_average",
            value: formatNumber(ema10, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, sma10);
        indicators.push({
            name: "Simple Moving Average (10)",
            indicator: "Simple Moving Average (10)",
            group: "moving_average",
            value: formatNumber(sma10, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, ema20);
        indicators.push({
            name: "Exponential Moving Average (20)",
            indicator: "Exponential Moving Average (20)",
            group: "moving_average",
            value: formatNumber(ema20, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, sma20);
        indicators.push({
            name: "Simple Moving Average (20)",
            indicator: "Simple Moving Average (20)",
            group: "moving_average",
            value: formatNumber(sma20, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, ema30);
        indicators.push({
            name: "Exponential Moving Average (30)",
            indicator: "Exponential Moving Average (30)",
            group: "moving_average",
            value: formatNumber(ema30, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, sma30);
        indicators.push({
            name: "Simple Moving Average (30)",
            indicator: "Simple Moving Average (30)",
            group: "moving_average",
            value: formatNumber(sma30, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, ema50);
        indicators.push({
            name: "Exponential Moving Average (50)",
            indicator: "Exponential Moving Average (50)",
            group: "moving_average",
            value: formatNumber(ema50, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, sma50);
        indicators.push({
            name: "Simple Moving Average (50)",
            indicator: "Simple Moving Average (50)",
            group: "moving_average",
            value: formatNumber(sma50, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, ema100);
        indicators.push({
            name: "Exponential Moving Average (100)",
            indicator: "Exponential Moving Average (100)",
            group: "moving_average",
            value: formatNumber(ema100, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, sma100);
        indicators.push({
            name: "Simple Moving Average (100)",
            indicator: "Simple Moving Average (100)",
            group: "moving_average",
            value: formatNumber(sma100, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, ema200);
        indicators.push({
            name: "Exponential Moving Average (200)",
            indicator: "Exponential Moving Average (200)",
            group: "moving_average",
            value: formatNumber(ema200, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, sma200);
        indicators.push({
            name: "Simple Moving Average (200)",
            indicator: "Simple Moving Average (200)",
            group: "moving_average",
            value: formatNumber(sma200, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal =
            !ichimoku
                ? "NEUTRAL"
                : ichimoku.leadingSpanA > ichimoku.leadingSpanB &&
                    ichimoku.baseLine > ichimoku.leadingSpanA &&
                    ichimoku.conversionLine > ichimoku.baseLine &&
                    price > ichimoku.conversionLine
                    ? "BUY"
                    : ichimoku.leadingSpanA < ichimoku.leadingSpanB &&
                        ichimoku.baseLine < ichimoku.leadingSpanA &&
                        ichimoku.conversionLine < ichimoku.baseLine &&
                        price < ichimoku.conversionLine
                        ? "SELL"
                        : "NEUTRAL";
        indicators.push({
            name: "Ichimoku Base Line (9, 26, 52, 26)",
            indicator: "Ichimoku Base Line (9, 26, 52, 26)",
            group: "moving_average",
            value: formatNumber(ichimoku?.baseLine, 3),
            signal,
            action: formatActionLabel(signal),
            components: ichimoku
                ? {
                    conversionLine: formatNumber(ichimoku.conversionLine, 3),
                    baseLine: formatNumber(ichimoku.baseLine, 3),
                    leadingSpanA: formatNumber(ichimoku.leadingSpanA, 3),
                    leadingSpanB: formatNumber(ichimoku.leadingSpanB, 3),
                }
                : null,
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, vwma20);
        indicators.push({
            name: "Volume Weighted Moving Average (20)",
            indicator: "Volume Weighted Moving Average (20)",
            group: "moving_average",
            value: formatNumber(vwma20, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }
    {
        const signal = resolveMovingAverageSignal(price, hma9);
        indicators.push({
            name: "Hull Moving Average (9)",
            indicator: "Hull Moving Average (9)",
            group: "moving_average",
            value: formatNumber(hma9, 3),
            signal,
            action: formatActionLabel(signal),
        });
    }

    const votes = tallyVotes(indicators);

    const oscillatorIndicators = indicators.filter((indicator) => indicator.group === "oscillator");
    const movingAverageIndicators = indicators.filter(
        (indicator) => indicator.group === "moving_average"
    );

    const oscillatorVotes = tallyVotes(oscillatorIndicators);
    const movingAverageVotes = tallyVotes(movingAverageIndicators);
    const summaryValue = resolveSummary(votes, indicators.length);
    const oscillatorSummaryValue = {
        summary: resolveSummary(oscillatorVotes, oscillatorIndicators.length),
        detail: oscillatorVotes,
        total: oscillatorIndicators.length,
    };
    const movingAverageSummaryValue = {
        summary: resolveSummary(movingAverageVotes, movingAverageIndicators.length),
        detail: movingAverageVotes,
        total: movingAverageIndicators.length,
    };

    return {
        status: "READY",
        summary: summaryValue,
        detail: votes,
        totalIndicators: indicators.length,
        symbol,
        requestedInterval: interval,
        effectiveInterval: interval,
        source: "Swissquote",
        sourceFunction: "public-quotes/bboquotes",
        price: formatNumber(price, 3),
        bid: formatNumber(quote.bid, 3),
        ask: formatNumber(quote.ask, 3),
        spread: formatNumber(quote.spread, 3),
        spreadProfile: quote.spreadProfile,
        topo: quote.topo,
        latestCandleAt: candles[candles.length - 1]?.timestamp || quote.timestamp,
        fetched_at: new Date().toISOString(),
        minuteHistoryPoints: minuteCandles.length,
        aggregatedCandles: candles.length,
        minCandlesRequired: MIN_CANDLES_REQUIRED,
        oscillatorSummary: oscillatorSummaryValue,
        movingAverageSummary: movingAverageSummaryValue,
        indicatorSections: buildIndicatorSections({
            summary: summaryValue,
            detail: votes,
            totalIndicators: indicators.length,
            oscillatorSummary: oscillatorSummaryValue,
            movingAverageSummary: movingAverageSummaryValue,
            oscillatorIndicators,
            movingAverageIndicators,
        }),
        indicators,
        note: "Summary sekarang menggabungkan 26 indikator: 11 Oscillators dan 15 Moving Averages. Perhitungan tetap berbasis candle hasil agregasi 1m/5m/15m/30m/60m, jadi hasilnya bisa sedikit berbeda dari TradingView karena feed dan metode chart tidak identik. VWMA(20) memakai tick volume proxy dari jumlah update quote per candle.",
    };
}

async function fetchSignalCached({ symbol, interval, profile } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeInterval(interval);
    const snapshot = await collectSignalSnapshot({
        symbol: normalizedSymbol.symbol,
        profile,
    });

    const candles = aggregateCandles(snapshot.minuteCandles, normalizedInterval);

    return buildIndicatorPayload({
        symbol: snapshot.symbol,
        interval: normalizedInterval,
        minuteCandles: snapshot.minuteCandles,
        candles,
        quote: snapshot.quote,
    });
}

module.exports = {
    collectSignalSnapshot,
    fetchSignalCached,
};
