package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "usage: db_helper <db_path> <query> [exec] OR db_helper seed-auth <db_path> <hex_token> OR db_helper seed-zero-vapid <db_path>\n")
		os.Exit(1)
	}

	if os.Args[1] == "seed-zero-vapid" {
		dbPath := os.Args[2]
		curve := elliptic.P256()
		priv, err := ecdsa.GenerateKey(curve, rand.Reader)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error generating key: %v\n", err)
			os.Exit(1)
		}

		var scalar32 [32]byte
		priv.D.FillBytes(scalar32[:])

		var x32, y32 [32]byte
		priv.PublicKey.X.FillBytes(x32[:])
		priv.PublicKey.Y.FillBytes(y32[:])

		pubUncompressed := make([]byte, 1+32+32)
		pubUncompressed[0] = 0x04
		copy(pubUncompressed[1:33], x32[:])
		copy(pubUncompressed[33:65], y32[:])

		pubB64 := base64.RawURLEncoding.EncodeToString(pubUncompressed)

		var zeroKey [32]byte
		block, err := aes.NewCipher(zeroKey[:])
		if err != nil {
			fmt.Fprintf(os.Stderr, "error creating cipher: %v\n", err)
			os.Exit(1)
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error creating gcm: %v\n", err)
			os.Exit(1)
		}

		var iv [12]byte
		if _, err := rand.Read(iv[:]); err != nil {
			fmt.Fprintf(os.Stderr, "error reading iv: %v\n", err)
			os.Exit(1)
		}

		aad := []byte("rootinbox/v1/vapid-private-key")
		sealed := gcm.Seal(nil, iv[:], scalar32[:], aad)
		encryptedHex := hex.EncodeToString(append(iv[:], sealed...))

		db, err := sql.Open("sqlite", dbPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error opening db: %v\n", err)
			os.Exit(1)
		}
		defer db.Close()

		now := time.Now().Unix()
		_, err = db.Exec("INSERT INTO application_keys (id, private_key_encrypted, public_key_uncompressed, created_at) VALUES ('vapid', ?, ?, ?)", encryptedHex, pubB64, now)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error inserting vapid key: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("seeded zero-vapid key: %s\n", pubB64)
		return
	}

	if os.Args[1] == "seed-auth" {
		if len(os.Args) < 4 {
			fmt.Fprintf(os.Stderr, "usage: db_helper seed-auth <db_path> <hex_token>\n")
			os.Exit(1)
		}
		dbPath := os.Args[2]
		hexToken := os.Args[3]
		tokenBytes, err := hex.DecodeString(hexToken)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error decoding hex token: %v\n", err)
			os.Exit(1)
		}
		hash := sha256.Sum256(tokenBytes)
		tokenHash := hex.EncodeToString(hash[:])

		db, err := sql.Open("sqlite", dbPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error opening db: %v\n", err)
			os.Exit(1)
		}
		defer db.Close()

		now := time.Now().Unix()
		expires := now + 86400

		if _, err := db.Exec("INSERT OR IGNORE INTO users (id, identity_hash, public_key, status, created_at) VALUES ('ci_user', 'ci_user_identity_hash', 'ci_pub_key', 'ACTIVE', ?)", now); err != nil {
			fmt.Fprintf(os.Stderr, "error inserting user: %v\n", err)
			os.Exit(1)
		}
		if _, err := db.Exec("INSERT OR IGNORE INTO sessions (id, user_id, x25519_public_key, session_version, expires_at, created_at) VALUES ('ci_session', 'ci_user', 'ci_x25519_key', 1, ?, ?)", expires, now); err != nil {
			fmt.Fprintf(os.Stderr, "error inserting session: %v\n", err)
			os.Exit(1)
		}
		if _, err := db.Exec("INSERT OR IGNORE INTO session_tokens (token_hash, session_id, created_at) VALUES (?, 'ci_session', ?)", tokenHash, now); err != nil {
			fmt.Fprintf(os.Stderr, "error inserting session token: %v\n", err)
			os.Exit(1)
		}
		return
	}

	dbPath := os.Args[1]
	query := os.Args[2]

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error opening db: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	if len(os.Args) > 3 && os.Args[3] == "exec" {
		_, err := db.Exec(query)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error executing: %v\n", err)
			os.Exit(1)
		}
		return
	}

	var result string
	err = db.QueryRow(query).Scan(&result)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return
		}
		fmt.Fprintf(os.Stderr, "error querying: %v\n", err)
		os.Exit(1)
	}
	fmt.Print(result)
}
