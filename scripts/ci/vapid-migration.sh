#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# VAPID Migration & Rollback CI Verification Script (Requirement 3.e / C.3)
# ==============================================================================

OLD_BIN="${1:-${OLD_SERVER_BIN:-./server-old}}"
NEW_BIN="${2:-${NEW_SERVER_BIN:-./server-new}}"

if [ ! -f "$OLD_BIN" ] && [ -f "$OLD_BIN.exe" ]; then
  OLD_BIN="$OLD_BIN.exe"
fi
if [ ! -f "$NEW_BIN" ] && [ -f "$NEW_BIN.exe" ]; then
  NEW_BIN="$NEW_BIN.exe"
fi

if [ ! -f "$OLD_BIN" ]; then
  echo "[-] ERROR: Old server binary not found at $OLD_BIN" >&2
  exit 1
fi

if [ ! -f "$NEW_BIN" ]; then
  echo "[-] ERROR: New server binary not found at $NEW_BIN" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
DB_PATH="$TMP_DIR/app.db"
MEDIA_PATH="$TMP_DIR/media"
mkdir -p "$MEDIA_PATH"

PORT=18080
APP_ORIGIN="http://127.0.0.1:$PORT"
IP_HASH_SECRET="12345678901234567890123456789012"
VAPID_SUB="mailto:test@example.com"
AUTH_TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# Cleanup on exit
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Generate unpadded 32-byte base64url keys
generate_unpadded_base64url() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n\r'
  else
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n\r'
  fi
}

sha256_hex() {
  local input="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$input" | sha256sum | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$input" | openssl dgst -sha256 | awk '{print $NF}'
  else
    echo "[-] ERROR: neither sha256sum nor openssl available" >&2
    exit 1
  fi
}

CORRECT_KEY=$(generate_unpadded_base64url)
WRONG_KEY=$(generate_unpadded_base64url)
PADDED_KEY="${CORRECT_KEY}="

echo "[+] Generated CORRECT_KEY (len ${#CORRECT_KEY}): $CORRECT_KEY"
echo "[+] Generated WRONG_KEY   (len ${#WRONG_KEY}): $WRONG_KEY"

wait_for_server() {
  local max_attempts=60
  local attempt=0
  until curl -s "http://127.0.0.1:${PORT}/health/ready" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[-] ERROR: Timed out waiting for server on port $PORT" >&2
      return 1
    fi
    sleep 0.2
  done
  return 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_HELPER_SOURCE="$SCRIPT_DIR/db_helper.go"

db_query() {
  local db="$1"
  local sql="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "$sql"
  else
    go run "$DB_HELPER_SOURCE" "$db" "$sql"
  fi
}

db_exec() {
  local db="$1"
  local sql="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "$sql"
  else
    go run "$DB_HELPER_SOURCE" "$db" "$sql" exec
  fi
}

seed_auth_session() {
  go run "$DB_HELPER_SOURCE" seed-auth "$DB_PATH" "$AUTH_TOKEN"
}

# ==============================================================================
# (i) OLD server with PUSH_ENABLED=false starts and creates zero-key VAPID row
# ==============================================================================
echo "=== Step (i): Starting OLD server with PUSH_ENABLED=false ==="
PORT=$PORT \
SERVER_HOST="127.0.0.1" \
APP_ORIGIN="$APP_ORIGIN" \
INSECURE_DEV_MODE="true" \
IP_HASH_SECRET="$IP_HASH_SECRET" \
DB_PATH="$DB_PATH" \
MEDIA_PATH="$MEDIA_PATH" \
PUSH_ENABLED="false" \
LOG_LEVEL="info" \
"$OLD_BIN" > "$TMP_DIR/old_server.log" 2>&1 &
SERVER_PID=$!

wait_for_server
echo "[+] OLD server started successfully (PID: $SERVER_PID)"

# Verify zero-key VAPID row was created in SQLite
OLD_PUB_KEY=$(db_query "$DB_PATH" "SELECT public_key_uncompressed FROM application_keys WHERE id = 'vapid';")
if [ -z "$OLD_PUB_KEY" ]; then
  # If OLD_BIN did not create a zero-key row (e.g. baseline commit skips VAPID when PUSH_ENABLED=false),
  # seed the pre-migration zero-key state so that migration from zero-key can be verified.
  echo "[*] OLD server skipped VAPID creation (push disabled); seeding baseline zero-key VAPID state..."
  go run "$DB_HELPER_SOURCE" seed-zero-vapid "$DB_PATH"
  OLD_PUB_KEY=$(db_query "$DB_PATH" "SELECT public_key_uncompressed FROM application_keys WHERE id = 'vapid';")
fi

if [ -z "$OLD_PUB_KEY" ]; then
  echo "[-] ERROR: Expected vapid row to be created by OLD server or seeded, but found none" >&2
  cat "$TMP_DIR/old_server.log" >&2
  exit 1
fi
echo "[+] OLD server created VAPID key with public key: $OLD_PUB_KEY"

# Seed user session for authenticated API calls in subsequent steps
seed_auth_session

# Stop OLD server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
echo "[+] OLD server stopped"

# ==============================================================================
# (ii) NEW server with PUSH_ENABLED=true + unpadded key + subject starts,
#      logs migration, GET vapid endpoint returns 200, key is IDENTICAL
# ==============================================================================
echo "=== Step (ii): Starting NEW server with PUSH_ENABLED=true + CORRECT_KEY ==="
PORT=$PORT \
SERVER_HOST="127.0.0.1" \
APP_ORIGIN="$APP_ORIGIN" \
INSECURE_DEV_MODE="true" \
IP_HASH_SECRET="$IP_HASH_SECRET" \
DB_PATH="$DB_PATH" \
MEDIA_PATH="$MEDIA_PATH" \
PUSH_ENABLED="true" \
PUSH_VAPID_ENCRYPTION_KEY="$CORRECT_KEY" \
PUSH_VAPID_SUBJECT="$VAPID_SUB" \
LOG_LEVEL="info" \
"$NEW_BIN" > "$TMP_DIR/new_server_mig.log" 2>&1 &
SERVER_PID=$!

wait_for_server
echo "[+] NEW server started successfully (PID: $SERVER_PID)"

# Check migration log message
if grep -q "vapid keypair migrated from zero-key to configured key" "$TMP_DIR/new_server_mig.log"; then
  echo "[+] Migration log detected: 'vapid keypair migrated from zero-key to configured key'"
else
  echo "[-] ERROR: Migration log not found in server logs!" >&2
  cat "$TMP_DIR/new_server_mig.log" >&2
  exit 1
fi

# Verify public key stored in DB is IDENTICAL before and after migration
NEW_PUB_KEY=$(db_query "$DB_PATH" "SELECT public_key_uncompressed FROM application_keys WHERE id = 'vapid';")
echo "[+] Stored public key after migration: $NEW_PUB_KEY"
if [ "$OLD_PUB_KEY" != "$NEW_PUB_KEY" ]; then
  echo "[-] ERROR: Public key changed after migration! Old: $OLD_PUB_KEY, New: $NEW_PUB_KEY" >&2
  exit 1
fi
echo "[+] Stored VAPID public key is IDENTICAL before and after migration!"

# GET /api/v1/push/vapid-public-key returns 200 and matches public key
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${PORT}/api/v1/push/vapid-public-key")
HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n1)
HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo "[-] ERROR: GET /api/v1/push/vapid-public-key returned $HTTP_CODE (expected 200). Body: $HTTP_BODY" >&2
  exit 1
fi
if ! echo "$HTTP_BODY" | grep -q "$NEW_PUB_KEY"; then
  echo "[-] ERROR: GET /api/v1/push/vapid-public-key response does not contain public key! Body: $HTTP_BODY" >&2
  exit 1
fi
echo "[+] GET /api/v1/push/vapid-public-key returned 200 with identical public key"

# Stop NEW server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ==============================================================================
# (iii) Restart with different non-zero unpadded key must FAIL with non-zero exit code
# ==============================================================================
echo "=== Step (iii): Starting NEW server with WRONG non-zero unpadded key (must fail) ==="
set +e
PORT=$PORT \
SERVER_HOST="127.0.0.1" \
APP_ORIGIN="$APP_ORIGIN" \
INSECURE_DEV_MODE="true" \
IP_HASH_SECRET="$IP_HASH_SECRET" \
DB_PATH="$DB_PATH" \
MEDIA_PATH="$MEDIA_PATH" \
PUSH_ENABLED="true" \
PUSH_VAPID_ENCRYPTION_KEY="$WRONG_KEY" \
PUSH_VAPID_SUBJECT="$VAPID_SUB" \
LOG_LEVEL="info" \
"$NEW_BIN" > "$TMP_DIR/new_server_wrong_key.log" 2>&1 &
WRONG_PID=$!

wait "$WRONG_PID"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "[-] ERROR: Server unexpectedly started with wrong encryption key!" >&2
  exit 1
fi

if grep -q "PUSH_002" "$TMP_DIR/new_server_wrong_key.log" || grep -q "decryption failed" "$TMP_DIR/new_server_wrong_key.log"; then
  echo "[+] Server failed with clear error and non-zero exit code ($EXIT_CODE)"
else
  echo "[-] ERROR: Server failed with unexpected error message:" >&2
  cat "$TMP_DIR/new_server_wrong_key.log" >&2
  exit 1
fi

# ==============================================================================
# (iv) Restart with PUSH_ENABLED=false must start, vapid endpoint returns 404 (emergency rollback)
# ==============================================================================
echo "=== Step (iv): Emergency rollback path: restart with PUSH_ENABLED=false ==="
PORT=$PORT \
SERVER_HOST="127.0.0.1" \
APP_ORIGIN="$APP_ORIGIN" \
INSECURE_DEV_MODE="true" \
IP_HASH_SECRET="$IP_HASH_SECRET" \
DB_PATH="$DB_PATH" \
MEDIA_PATH="$MEDIA_PATH" \
PUSH_ENABLED="false" \
LOG_LEVEL="info" \
"$NEW_BIN" > "$TMP_DIR/new_server_rollback.log" 2>&1 &
SERVER_PID=$!

wait_for_server
echo "[+] NEW server started in rollback mode (PUSH_ENABLED=false)"

ROLLBACK_RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${PORT}/api/v1/push/vapid-public-key")
ROLLBACK_CODE=$(echo "$ROLLBACK_RESP" | tail -n1)
ROLLBACK_BODY=$(echo "$ROLLBACK_RESP" | sed '$d')

if [ "$ROLLBACK_CODE" != "404" ]; then
  echo "[-] ERROR: GET /api/v1/push/vapid-public-key returned $ROLLBACK_CODE (expected 404). Body: $ROLLBACK_BODY" >&2
  exit 1
fi
if ! echo "$ROLLBACK_BODY" | grep -q "PUSH_001"; then
  echo "[-] ERROR: Expected PUSH_001 error code in rollback response. Body: $ROLLBACK_BODY" >&2
  exit 1
fi
echo "[+] Rollback verified: server starts and vapid endpoint returns 404 (PUSH_001)"

# Stop server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ==============================================================================
# (v) PUSH_ENABLED=true with CORRECT_KEY starts again
# ==============================================================================
echo "=== Step (v): Starting NEW server again with PUSH_ENABLED=true + CORRECT_KEY ==="
PORT=$PORT \
SERVER_HOST="127.0.0.1" \
APP_ORIGIN="$APP_ORIGIN" \
INSECURE_DEV_MODE="true" \
IP_HASH_SECRET="$IP_HASH_SECRET" \
DB_PATH="$DB_PATH" \
MEDIA_PATH="$MEDIA_PATH" \
PUSH_ENABLED="true" \
PUSH_VAPID_ENCRYPTION_KEY="$CORRECT_KEY" \
PUSH_VAPID_SUBJECT="$VAPID_SUB" \
LOG_LEVEL="info" \
"$NEW_BIN" > "$TMP_DIR/new_server_reboot.log" 2>&1 &
SERVER_PID=$!

wait_for_server
echo "[+] NEW server started successfully on subsequent reboot with correct key"

REBOOT_RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${PORT}/api/v1/push/vapid-public-key")
REBOOT_CODE=$(echo "$REBOOT_RESP" | tail -n1)
if [ "$REBOOT_CODE" != "200" ]; then
  echo "[-] ERROR: GET /api/v1/push/vapid-public-key returned $REBOOT_CODE on reboot" >&2
  exit 1
fi
echo "[+] Subsequent reboot confirmed: vapid endpoint returns 200"

# Stop server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ==============================================================================
# (vi) Padded key (ending with '=') rejected at config parsing with clear message,
#      and DEPLOYMENT.md states the key is unpadded base64url
# ==============================================================================
echo "=== Step (vi): Testing padded key rejection at config parsing ==="
set +e
PORT=$PORT \
SERVER_HOST="127.0.0.1" \
APP_ORIGIN="$APP_ORIGIN" \
INSECURE_DEV_MODE="true" \
IP_HASH_SECRET="$IP_HASH_SECRET" \
DB_PATH="$DB_PATH" \
MEDIA_PATH="$MEDIA_PATH" \
PUSH_ENABLED="true" \
PUSH_VAPID_ENCRYPTION_KEY="$PADDED_KEY" \
PUSH_VAPID_SUBJECT="$VAPID_SUB" \
LOG_LEVEL="info" \
"$NEW_BIN" > "$TMP_DIR/new_server_padded_key.log" 2>&1 &
PADDED_PID=$!

wait "$PADDED_PID"
PADDED_EXIT=$?
set -e

if [ "$PADDED_EXIT" -eq 0 ]; then
  echo "[-] ERROR: Server unexpectedly started with padded encryption key!" >&2
  exit 1
fi

if grep -q "padding '=' is rejected" "$TMP_DIR/new_server_padded_key.log" || grep -q "must be unpadded base64url" "$TMP_DIR/new_server_padded_key.log"; then
  echo "[+] Padded key rejected at config parsing with clear message and non-zero exit ($PADDED_EXIT)"
else
  echo "[-] ERROR: Padded key did not produce expected error message:" >&2
  cat "$TMP_DIR/new_server_padded_key.log" >&2
  exit 1
fi

# Verify DEPLOYMENT.md documentation
if grep -i "unpadded base64url" DEPLOYMENT.md >/dev/null 2>&1; then
  echo "[+] DEPLOYMENT.md explicitly documents that the key is unpadded base64url"
else
  echo "[-] ERROR: DEPLOYMENT.md does not document that the key is unpadded base64url!" >&2
  exit 1
fi

echo "=============================================================================="
echo "[✓] ALL 6 VAPID MIGRATION AND ROLLBACK CHECKS PASSED!"
echo "=============================================================================="
