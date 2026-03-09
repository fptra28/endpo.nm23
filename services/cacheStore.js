// services/cacheStore.js
const { sql } = require("@vercel/postgres");


function ensureConnEnv() {
    if (!process.env.POSTGRES_URL && process.env.DATABASE_URL) {
        process.env.POSTGRES_URL = process.env.DATABASE_URL;
    }
}

async function ensureTable() {
    ensureConnEnv();
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) return;
    // create table if not exists
    await sql`
        CREATE TABLE IF NOT EXISTS cache_store (
            key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            fetched_at TIMESTAMPTZ NOT NULL
        );
    `;
}

async function getCache(key) {
    ensureConnEnv();
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) return null;
    await ensureTable();
    const rows = await sql`
        SELECT key, payload, fetched_at
        FROM cache_store
        WHERE key = ${key}
        LIMIT 1;
    `;
    if (!rows || !rows.rows || rows.rows.length === 0) return null;
    return rows.rows[0];
}

async function setCache(key, payload, fetchedAtIso) {
    ensureConnEnv();
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) return;
    await ensureTable();
    await sql`
        INSERT INTO cache_store (key, payload, fetched_at)
        VALUES (${key}, ${payload}, ${fetchedAtIso})
        ON CONFLICT (key) DO UPDATE
        SET payload = EXCLUDED.payload,
            fetched_at = EXCLUDED.fetched_at;
    `;
}

module.exports = { getCache, setCache };
