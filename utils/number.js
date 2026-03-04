// utils/number.js

function parseIdNumber(text) {
    if (text == null) return null;

    const cleaned = String(text)
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\./g, "") // ribuan
        .replace(",", "."); // desimal

    const m = cleaned.match(/-?\d+(\.\d+)?/);
    if (!m) return null;

    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

module.exports = { parseIdNumber };