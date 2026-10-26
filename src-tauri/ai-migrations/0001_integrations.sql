-- App-level metadata only. Secrets remain in the operating system credential store.
CREATE TABLE aiIntegrations (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL UNIQUE CHECK (provider IN ('openai', 'anthropic', 'openaiOauth')),
    model TEXT NOT NULL DEFAULT '',
    maxOutputTokens INTEGER NOT NULL CHECK (maxOutputTokens > 0),
    reasoningEffort TEXT,
    credentialReference TEXT NOT NULL
);
CREATE TABLE aiOAuthAccounts (
    clientId TEXT PRIMARY KEY NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT,
    email TEXT,
    credentialReference TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
    expiresAt INTEGER,
    connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0, 1))
);
CREATE TABLE aiSettings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value))
);
CREATE TABLE aiPreferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activeIntegrationId TEXT REFERENCES aiIntegrations(id) ON DELETE SET NULL,
    legacyImported INTEGER NOT NULL DEFAULT 0 CHECK (legacyImported IN (0, 1))
);
INSERT INTO aiPreferences (id) VALUES (1);
