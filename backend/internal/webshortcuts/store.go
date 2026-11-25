package webshortcuts

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"net/url"
	"strings"
)

//go:embed 001_shortcuts.sql
var schema string

var errMissingSecret = errors.New("请输入密钥值")

type shortcut struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	URL           string `json:"url"`
	ParameterName string `json:"parameterName"`
}

type shortcutForm struct {
	Name          string `json:"name"`
	URL           string `json:"url"`
	ParameterName string `json:"parameterName"`
	Secret        string `json:"secret"`
}

func Initialize(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, schema)
	return err
}

func (form *shortcutForm) validate() error {
	form.Name = strings.TrimSpace(form.Name)
	form.URL = strings.TrimSpace(form.URL)
	form.ParameterName = strings.TrimSpace(form.ParameterName)
	if form.Name == "" {
		return errors.New("请输入快捷方式名称")
	}
	target, err := url.Parse(form.URL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" || target.User != nil {
		return errors.New("请输入完整的 HTTP 或 HTTPS 网页地址")
	}
	if form.ParameterName == "" {
		if form.Secret != "" {
			return errors.New("请输入登录参数名")
		}
		return nil
	}
	query, err := url.ParseQuery(target.RawQuery)
	if err != nil {
		return errors.New("网页地址包含无效的查询参数")
	}
	if query.Has(form.ParameterName) {
		return errors.New("请从网页地址移除登录参数，并把密钥填入密钥值")
	}
	return nil
}

func (form shortcutForm) shortcut(id int64) shortcut {
	return shortcut{ID: id, Name: form.Name, URL: form.URL, ParameterName: form.ParameterName}
}

type handler struct {
	db *sql.DB
}

func (h handler) shortcuts(ctx context.Context) ([]shortcut, error) {
	rows, err := h.db.QueryContext(ctx, "SELECT id, name, url, parameter_name FROM web_shortcuts ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	shortcuts := []shortcut{}
	for rows.Next() {
		var item shortcut
		if err := rows.Scan(&item.ID, &item.Name, &item.URL, &item.ParameterName); err != nil {
			return nil, err
		}
		shortcuts = append(shortcuts, item)
	}
	return shortcuts, rows.Err()
}

func (h handler) insert(ctx context.Context, form shortcutForm) (shortcut, error) {
	if form.ParameterName != "" && form.Secret == "" {
		return shortcut{}, errMissingSecret
	}
	var id int64
	err := h.db.QueryRowContext(ctx, `INSERT INTO web_shortcuts (name, url, parameter_name, secret)
		VALUES (?, ?, ?, ?) RETURNING id`, form.Name, form.URL, form.ParameterName, form.Secret).Scan(&id)
	return form.shortcut(id), err
}

func (h handler) replace(ctx context.Context, id int64, form shortcutForm) (shortcut, error) {
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return shortcut{}, err
	}
	defer tx.Rollback()

	if form.ParameterName != "" && form.Secret == "" {
		err := tx.QueryRowContext(ctx, "SELECT secret FROM web_shortcuts WHERE id = ?", id).Scan(&form.Secret)
		if err != nil {
			return shortcut{}, err
		}
		if form.Secret == "" {
			return shortcut{}, errMissingSecret
		}
	}
	var updatedID int64
	err = tx.QueryRowContext(ctx, `UPDATE web_shortcuts SET name = ?, url = ?, parameter_name = ?, secret = ?
		WHERE id = ? RETURNING id`, form.Name, form.URL, form.ParameterName, form.Secret, id).Scan(&updatedID)
	if err != nil {
		return shortcut{}, err
	}
	return form.shortcut(updatedID), tx.Commit()
}

func (h handler) remove(ctx context.Context, id int64) error {
	return h.db.QueryRowContext(ctx, "DELETE FROM web_shortcuts WHERE id = ? RETURNING id", id).Scan(&id)
}

func (h handler) destination(ctx context.Context, id int64) (string, error) {
	var address, parameter, secret string
	if err := h.db.QueryRowContext(ctx, "SELECT url, parameter_name, secret FROM web_shortcuts WHERE id = ?", id).
		Scan(&address, &parameter, &secret); err != nil {
		return "", err
	}
	if parameter == "" {
		return address, nil
	}
	target, err := url.Parse(address)
	if err != nil {
		return "", err
	}
	query := target.Query()
	query.Set(parameter, secret)
	target.RawQuery = query.Encode()
	return target.String(), nil
}
