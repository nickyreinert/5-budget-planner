CREATE TABLE IF NOT EXISTS sync_data (
  user_sub TEXT NOT NULL,
  collection TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_sub, collection)
);
