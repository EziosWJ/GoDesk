package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"godesk/internal/auth"

	"golang.org/x/term"
)

func resetPassword(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("godesk reset-password", flag.ContinueOnError)
	dataDir := flags.String("data-dir", "./data", "directory for persistent goDesk data")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("usage: godesk reset-password [-data-dir DIR]")
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("password reset requires an interactive terminal")
	}

	path, err := databasePath(*dataDir)
	if err != nil {
		return err
	}
	db, err := openDatabase(ctx, path, "rw")
	if err != nil {
		return err
	}
	defer db.Close()
	store, err := auth.Open(ctx, db)
	if err != nil {
		return err
	}

	password, err := readNewPassword()
	if err != nil {
		return err
	}
	if err := store.ResetPassword(ctx, password); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Password reset. Sign in again with the new password.")
	return nil
}

func readNewPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	state, err := term.MakeRaw(fd)
	if err != nil {
		return "", err
	}
	defer term.Restore(fd, state)
	terminal := term.NewTerminal(struct {
		io.Reader
		io.Writer
	}{os.Stdin, os.Stderr}, "")

	password, err := terminal.ReadPassword("New password: ")
	if err != nil {
		return "", err
	}
	if password == "" {
		return "", auth.ErrEmptyPassword
	}
	confirmation, err := terminal.ReadPassword("Confirm password: ")
	if err != nil {
		return "", err
	}
	if password != confirmation {
		return "", errors.New("passwords do not match")
	}
	return password, nil
}
