// services/cacheStore.js
const { Pool } = require("pg");

let pool;

function getPool() {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) return null;

    if (!pool) {
        pool = new Pool({
            connectionString,
            max: Number(process.env.POSTGRES_POOL_MAX || 10),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });
        pool.on("error", (error) => {
            console.error("Koneksi PostgreSQL idle mengalami error:", error.message);
        });
    }

    return pool;
}

async function ensureTable() {
    const db = getPool();
    if (!db) return;
    // create table if not exists
    await db.query(`
        CREATE TABLE IF NOT EXISTS cache_store (
            key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            fetched_at TIMESTAMPTZ NOT NULL
        );
    `);
}

async function getCache(key) {
    const db = getPool();
    if (!db) return null;
    await ensureTable();
    const result = await db.query(
        `
        SELECT key, payload, fetched_at
        FROM cache_store
        WHERE key = $1
        LIMIT 1;
        `,
        [key]
    );
    return result.rows[0] || null;
}

async function setCache(key, payload, fetchedAtIso) {
    const db = getPool();
    if (!db) return;
    await ensureTable();
    await db.query(
        `
        INSERT INTO cache_store (key, payload, fetched_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (key) DO UPDATE
        SET payload = EXCLUDED.payload,
            fetched_at = EXCLUDED.fetched_at;
        `,
        [key, JSON.stringify(payload), fetchedAtIso]
    );
}

module.exports = { getCache, setCache };
