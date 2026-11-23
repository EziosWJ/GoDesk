package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	_ "embed"
	"errors"

	"golang.org/x/crypto/argon2"
)

//go:embed 001_operator.sql
var schema string

var ErrNotInitialized = errors.New("goDesk is not initialized")
var ErrEmptyPassword = errors.New("password must not be empty")

type Store struct {
	db *sql.DB
}

type credentials struct {
	salt       []byte
	hash       []byte
	signingKey []byte
}

func Open(ctx context.Context, db *sql.DB) (*Store, error) {
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) read(ctx context.Context) (credentials, error) {
	var c credentials
	err := s.db.QueryRowContext(ctx, "SELECT salt, hash, signing_key FROM operator_credentials WHERE id = 1").
		Scan(&c.salt, &c.hash, &c.signingKey)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotInitialized
	}
	return c, err
}

func hashPassword(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, 2, 19*1024, 1, 32)
}

func (c credentials) matches(password string) bool {
	return subtle.ConstantTimeCompare(c.hash, hashPassword(password, c.salt)) == 1
}

func newCredentials(password string) credentials {
	salt := make([]byte, 16)
	key := make([]byte, 32)
	rand.Read(salt)
	rand.Read(key)
	return credentials{salt: salt, hash: hashPassword(password, salt), signingKey: key}
}

func (s *Store) initialize(ctx context.Context, c credentials) (bool, error) {
	result, err := s.db.ExecContext(ctx, `INSERT INTO operator_credentials(id, salt, hash, signing_key)
		VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, c.salt, c.hash, c.signingKey)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

// replace atomically rotates the password and signing key. The previous key
// ensures that a concurrent change cannot overwrite credentials it never verified.
func (s *Store) replace(ctx context.Context, current, next credentials) (bool, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE operator_credentials SET salt = ?, hash = ?, signing_key = ?
		WHERE id = 1 AND signing_key = ?`, next.salt, next.hash, next.signingKey, current.signingKey)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

func (s *Store) ResetPassword(ctx context.Context, password string) error {
	if password == "" {
		return ErrEmptyPassword
	}
	current, err := s.read(ctx)
	if err != nil {
		return err
	}
	changed, err := s.replace(ctx, current, newCredentials(password))
	if err != nil {
		return err
	}
	if !changed {
		return errors.New("password changed concurrently; try again")
	}
	return nil
}
