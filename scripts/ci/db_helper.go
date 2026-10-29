package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "usage: db_helper <db_path> <query> [exec] OR db_helper seed-auth <db_path> <hex_token>\n")
		os.Exit(1)
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
		fmt.Fprintf(os.Stderr, "error querying: %v\n", err)
		os.Exit(1)
	}
	fmt.Print(result)
}
