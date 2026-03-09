CREATE TABLE IF NOT EXISTS cache_store (
    key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL
);
