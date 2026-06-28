CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  amount_usd_minor INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  purchase_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','committed','released')),
  credential_id TEXT
);
CREATE INDEX reservations_window ON reservations(rule_name, created_at, status);
CREATE INDEX reservations_purchase ON reservations(purchase_id);

CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  rail TEXT NOT NULL,
  authorization_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  env TEXT NOT NULL
);

CREATE TABLE audit (
  entry_hash TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  intent_id TEXT,
  authorization_hash TEXT,
  policy_hash TEXT,
  decision TEXT,
  entry_json TEXT NOT NULL
);
CREATE INDEX audit_ts ON audit(ts);
CREATE INDEX audit_authorization ON audit(authorization_hash);

CREATE TABLE policy_snapshots (
  policy_hash TEXT PRIMARY KEY,
  yaml_bytes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  approval_prompt_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  policy_hash TEXT NOT NULL,
  authorization_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE fx_quotes (
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  rate REAL NOT NULL,
  ts TEXT NOT NULL,
  source TEXT NOT NULL
);
