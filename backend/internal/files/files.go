package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

var (
	errPath     = errors.New("需要有效的绝对路径或文件名")
	errType     = errors.New("不支持此文件类型")
	errChanged  = errors.New("源文件已更改，请另存为")
	errSize     = errors.New("文本超过 5 MiB")
	errEncoding = errors.New("文件不是有效的 UTF-8 文本")
)

type entry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
	TargetKind  string `json:"targetKind,omitempty"`
	TargetError string `json:"targetError,omitempty"`
}

func pathOf(value string) (string, error) {
	if !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
		return "", errPath
	}
	return filepath.Clean(value), nil
}

func validName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\x00")
}

func fileKind(mode fs.FileMode) string {
	switch {
	case mode.IsDir():
		return "directory"
	case mode.IsRegular():
		return "file"
	case mode&fs.ModeSymlink != 0:
		return "symlink"
	case mode&fs.ModeNamedPipe != 0:
		return "fifo"
	case mode&fs.ModeSocket != 0:
		return "socket"
	case mode&fs.ModeDevice != 0:
		return "device"
	default:
		return "other"
	}
}

func list(path string) ([]entry, error) {
	items, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	result := make([]entry, 0, len(items))
	for _, item := range items {
		info, err := item.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		child := filepath.Join(path, item.Name())
		next := entry{Name: item.Name(), Path: child, Kind: fileKind(info.Mode()), Size: info.Size()}
		if next.Kind == "symlink" {
			target, err := os.Stat(child)
			if err != nil {
				next.TargetError = err.Error()
			} else {
				next.TargetKind = fileKind(target.Mode())
			}
		}
		result = append(result, next)
	}
	return result, nil
}

func openRegular(path string, flag int) (*os.File, fs.FileInfo, error) {
	initial, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if !initial.Mode().IsRegular() {
		return nil, nil, errType
	}
	file, err := os.OpenFile(path, flag|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = errType
	}
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	return file, info, nil
}

type result struct {
	Path    string `json:"path"`
	Copied  bool   `json:"copied,omitempty"`
	Skipped bool   `json:"skipped,omitempty"`
}

type cleanupError struct {
	path string
	err  error
}

func (e *cleanupError) Error() string {
	return fmt.Sprintf("目标已创建，源清理失败：%v", e.err)
}

func numbered(path string, n int, directory bool) string {
	name := filepath.Base(path)
	extension := filepath.Ext(name)
	if extension == name || directory {
		extension = ""
	}
	return filepath.Join(filepath.Dir(path), fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, extension), n, extension))
}

func chooseTarget(path, conflict string, directory bool, publish func(string) error) (result, error) {
	target := path
	for n := 1; ; n++ {
		err := publish(target)
		if !errors.Is(err, fs.ErrExist) {
			return result{Path: target}, err
		}
		switch conflict {
		case "keep":
			target = numbered(path, n, directory)
		case "skip":
			return result{Path: target, Skipped: true}, nil
		default:
			return result{}, err
		}
	}
}

func renameExclusive(source, target string) error {
	return unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE)
}

func existingTarget(path, conflict string) (result, bool, error) {
	_, err := os.Lstat(path)
	switch {
	case err == nil && conflict == "skip":
		return result{Path: path, Skipped: true}, true, nil
	case err == nil && conflict != "keep":
		return result{}, true, fs.ErrExist
	case err == nil || errors.Is(err, fs.ErrNotExist):
		return result{}, false, nil
	default:
		return result{}, true, err
	}
}

type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func writeStream(ctx context.Context, path string, body io.Reader, mode fs.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, writeErr := io.Copy(file, contextReader{ctx, body})
	return errors.Join(writeErr, file.Close())
}

func copyTree(ctx context.Context, source, target string, ancestors []fs.FileInfo, record func(string, fs.FileInfo)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if record != nil {
		record(source, info)
	}
	switch fileKind(info.Mode()) {
	case "symlink":
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(link, target)
	case "directory":
		for _, ancestor := range ancestors {
			if os.SameFile(info, ancestor) {
				return errRecursive
			}
		}
		children, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		if err := os.Mkdir(target, 0700); err != nil {
			return err
		}
		for _, child := range children {
			if err := copyTree(ctx, filepath.Join(source, child.Name()), filepath.Join(target, child.Name()), append(ancestors, info), record); err != nil {
				return err
			}
		}
		if err := os.Chmod(target, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chtimes(target, info.ModTime(), info.ModTime())
	case "file":
		file, err := os.OpenFile(source, os.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		actual, err := file.Stat()
		if err != nil {
			return err
		}
		if !actual.Mode().IsRegular() {
			return errType
		}
		if err := writeStream(ctx, target, file, info.Mode().Perm()); err != nil {
			return err
		}
		if err := os.Chmod(target, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chtimes(target, info.ModTime(), info.ModTime())
	default:
		return errType
	}
}

// Stage beside the destination so publishing is a single no-replace rename.
func stage(ctx context.Context, target, conflict string, directory bool, write func(string) error) (result, error) {
	if outcome, done, err := existingTarget(target, conflict); done {
		return outcome, err
	}
	temp, err := os.MkdirTemp(filepath.Dir(target), ".godesk-")
	if err != nil {
		return result{}, err
	}
	defer discardStage(temp)
	item := filepath.Join(temp, "item")
	if err := write(item); err != nil {
		return result{}, err
	}
	if err := ctx.Err(); err != nil {
		return result{}, err
	}
	return chooseTarget(target, conflict, directory, func(path string) error {
		return renameExclusive(item, path)
	})
}

func discardStage(path string) {
	if err := os.RemoveAll(path); err == nil {
		return
	}
	// A copied directory may already have its source's read-only mode.
	_ = filepath.WalkDir(path, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.IsDir() {
			return os.Chmod(path, 0700)
		}
		return err
	})
	_ = os.RemoveAll(path)
}

var errRecursive = errors.New("不能将目录复制或移动到自身或子目录")

func transfer(ctx context.Context, source, destination, conflict string, move bool) (result, error) {
	info, err := os.Lstat(source)
	if err != nil {
		return result{}, err
	}
	kind := fileKind(info.Mode())
	if kind != "directory" && kind != "file" && kind != "symlink" {
		return result{}, errType
	}
	parent, err := filepath.EvalSymlinks(destination)
	if err != nil {
		return result{}, err
	}
	if info.IsDir() {
		// Check actual ancestors so aliases through symlinks or mount points are covered.
		for ancestor := parent; ; ancestor = filepath.Dir(ancestor) {
			directory, err := os.Stat(ancestor)
			if err != nil {
				return result{}, err
			}
			if os.SameFile(info, directory) {
				return result{}, errRecursive
			}
			if ancestor == "/" {
				break
			}
		}
	}
	target := filepath.Join(destination, filepath.Base(source))
	if move {
		if currentParent, err := filepath.EvalSymlinks(filepath.Dir(source)); err != nil {
			return result{}, err
		} else if currentParent == parent {
			return result{Path: target, Skipped: true}, nil
		}
		outcome, err := chooseTarget(target, conflict, info.IsDir(), func(path string) error {
			if _, done, err := existingTarget(path, ""); done {
				return err
			}
			return renameExclusive(source, path)
		})
		if !errors.Is(err, unix.EXDEV) {
			return outcome, err
		}
	}
	var record func(string, fs.FileInfo)
	snapshot := map[string]fs.FileInfo{}
	if move {
		record = func(path string, info fs.FileInfo) { snapshot[path] = info }
	}
	checkSource := func() error {
		for path, before := range snapshot {
			current, err := os.Lstat(path)
			if err != nil {
				return err
			}
			beforeStat, currentStat := before.Sys().(*syscall.Stat_t), current.Sys().(*syscall.Stat_t)
			if !os.SameFile(before, current) || beforeStat.Mtim != currentStat.Mtim || beforeStat.Ctim != currentStat.Ctim || before.Size() != current.Size() {
				return errors.New("复制期间源文件发生变化")
			}
		}
		return nil
	}
	outcome, err := stage(ctx, target, conflict, info.IsDir(), func(path string) error {
		if err := copyTree(ctx, source, path, nil, record); err != nil {
			return err
		}
		return checkSource()
	})
	if err != nil || outcome.Skipped || !move {
		return outcome, err
	}
	err = checkSource()
	if err == nil {
		err = os.RemoveAll(source)
	}
	if err != nil {
		return outcome, &cleanupError{path: outcome.Path, err: err}
	}
	outcome.Copied = true
	return outcome, nil
}
