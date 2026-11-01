-- Migration 000022: Zero-Knowledge Vault & Decoupled Authentication Keypair
-- RFC Stage 1a: Decoupled Auth Keypair, KDF Parameters, and Sealed Vault Storage

-- 1. Extend users table with decoupled authentication and KDF parameters
ALTER TABLE users ADD COLUMN auth_pubkey TEXT;
ALTER TABLE users ADD COLUMN kdf_salt TEXT;
ALTER TABLE users ADD COLUMN kdf_memory_kib INTEGER NOT NULL DEFAULT 32768;
ALTER TABLE users ADD COLUMN kdf_iterations INTEGER NOT NULL DEFAULT 4;
ALTER TABLE users ADD COLUMN kdf_parallelism INTEGER NOT NULL DEFAULT 1;

-- 2. Create Zero-Knowledge User Vault table
CREATE TABLE zk_vaults (
    user_id        TEXT PRIMARY KEY,
    version        INTEGER NOT NULL DEFAULT 1,
    ciphertext     BLOB NOT NULL,
    signature      TEXT NOT NULL,
    updated_at     INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Create Zero-Knowledge Conversation Epoch Keys table (Prepared for Stage 1b)
CREATE TABLE conversation_epoch_keys (
    conversation_id TEXT NOT NULL,
    epoch_number    INTEGER NOT NULL,
    user_id         TEXT NOT NULL,
    wrapped_key     BLOB NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, epoch_number, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
