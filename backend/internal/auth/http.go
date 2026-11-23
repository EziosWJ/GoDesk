package auth

import (
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	cookieName  = "godesk_session"
	sessionLife = 7 * 24 * time.Hour
)

type session struct {
	Status    string     `json:"status"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

type passwordForm struct {
	Password        string `json:"password"`
	CurrentPassword string `json:"currentPassword"`
}

func (s *Store) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/auth/session", s.session)
	mux.HandleFunc("POST /api/v1/auth/setup", s.setup)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/logout", logout)
	mux.HandleFunc("POST /api/v1/auth/password", s.changePassword)
}

func (s *Store) session(w http.ResponseWriter, r *http.Request) {
	current, err := s.read(r.Context())
	switch {
	case errors.Is(err, ErrNotInitialized):
		writeSession(w, session{Status: "setup"})
	case err != nil:
		internalError(w, err)
	default:
		if expires := sessionExpiry(r, current.signingKey); expires != nil {
			writeSession(w, session{Status: "authenticated", ExpiresAt: expires})
		} else {
			writeSession(w, session{Status: "login"})
		}
	}
}

func (s *Store) setup(w http.ResponseWriter, r *http.Request) {
	form, ok := readPassword(w, r)
	if !ok {
		return
	}
	_, err := s.read(r.Context())
	if err == nil {
		http.Error(w, "already initialized", http.StatusConflict)
		return
	}
	if !errors.Is(err, ErrNotInitialized) {
		internalError(w, err)
		return
	}
	next := newCredentials(form.Password)
	created, err := s.initialize(r.Context(), next)
	if err != nil {
		internalError(w, err)
		return
	}
	if !created {
		http.Error(w, "already initialized", http.StatusConflict)
		return
	}
	startSession(w, r, next.signingKey)
}

func (s *Store) login(w http.ResponseWriter, r *http.Request) {
	form, ok := readPassword(w, r)
	if !ok {
		return
	}
	current, err := s.read(r.Context())
	if errors.Is(err, ErrNotInitialized) {
		http.Error(w, "setup required", http.StatusConflict)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if !current.matches(form.Password) {
		http.Error(w, "incorrect password", http.StatusUnauthorized)
		return
	}
	startSession(w, r, current.signingKey)
}

func logout(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	cookie := sessionCookie(r)
	cookie.MaxAge = -1
	cookie.Expires = time.Unix(1, 0).UTC()
	http.SetCookie(w, cookie)
	writeSession(w, session{Status: "login"})
}

func (s *Store) changePassword(w http.ResponseWriter, r *http.Request) {
	current, err := s.read(r.Context())
	if err != nil && !errors.Is(err, ErrNotInitialized) {
		internalError(w, err)
		return
	}
	if err != nil || sessionExpiry(r, current.signingKey) == nil {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	form, ok := readPassword(w, r)
	if !ok {
		return
	}
	if !current.matches(form.CurrentPassword) {
		http.Error(w, "incorrect current password", http.StatusForbidden)
		return
	}
	next := newCredentials(form.Password)
	changed, err := s.replace(r.Context(), current, next)
	if err != nil {
		internalError(w, err)
		return
	}
	if !changed {
		http.Error(w, "login required", http.StatusUnauthorized)
		return
	}
	startSession(w, r, next.signingKey)
}

func requireJSON(w http.ResponseWriter, r *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "expected application/json", http.StatusUnsupportedMediaType)
		return false
	}
	return true
}

func readPassword(w http.ResponseWriter, r *http.Request) (passwordForm, bool) {
	var form passwordForm
	if !requireJSON(w, r) {
		return form, false
	}
	if err := json.NewDecoder(r.Body).Decode(&form); err != nil || form.Password == "" {
		http.Error(w, "provide a non-empty password", http.StatusBadRequest)
		return form, false
	}
	return form, true
}

func sessionCookie(r *http.Request) *http.Cookie {
	return &http.Cookie{
		Name: cookieName, Path: "/", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode,
	}
}

func startSession(w http.ResponseWriter, r *http.Request, key []byte) {
	expires := jwt.NewNumericDate(time.Now().Add(sessionLife))
	claims := jwt.RegisteredClaims{Subject: "operator", ExpiresAt: expires}
	value, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(key)
	if err != nil {
		internalError(w, err)
		return
	}
	cookie := sessionCookie(r)
	cookie.Value = value
	cookie.Expires = expires.Time
	cookie.MaxAge = int(sessionLife.Seconds())
	http.SetCookie(w, cookie)
	writeSession(w, session{Status: "authenticated", ExpiresAt: &expires.Time})
}

func sessionExpiry(r *http.Request, key []byte) *time.Time {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	var claims jwt.RegisteredClaims
	token, err := jwt.ParseWithClaims(cookie.Value, &claims, func(*jwt.Token) (any, error) {
		return key, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithExpirationRequired(), jwt.WithSubject("operator"))
	if err != nil || !token.Valid {
		return nil
	}
	return &claims.ExpiresAt.Time
}

func writeSession(w http.ResponseWriter, data session) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}

func internalError(w http.ResponseWriter, err error) {
	slog.Error("authentication request failed", "error", err)
	http.Error(w, "authentication unavailable", http.StatusInternalServerError)
}
