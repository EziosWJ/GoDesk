package files

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

var (
	errArchive   = errors.New("归档文件无效或已损坏")
	errTraversal = errors.New("归档包含越界路径")
)

type archiveSource struct {
	path string
	name string
	info fs.FileInfo
}

// archiveSources validates the selection before any response is written so a
// streaming download can fail with a normal JSON error instead of a broken zip.
func archiveSources(values []string) ([]archiveSource, error) {
	if len(values) == 0 {
		return nil, errPath
	}
	seen := make(map[string]bool, len(values))
	sources := make([]archiveSource, 0, len(values))
	for _, value := range values {
		path, err := pathOf(value)
		if err != nil {
			return nil, err
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		switch fileKind(info.Mode()) {
		case "file":
			file, _, err := openRegular(path, os.O_RDONLY)
			if err != nil {
				return nil, err
			}
			_ = file.Close()
		case "directory":
			directory, err := os.Open(path)
			if err != nil {
				return nil, err
			}
			_ = directory.Close()
		case "symlink":
			if _, err := os.Readlink(path); err != nil {
				return nil, err
			}
		default:
			return nil, errType
		}
		sources = append(sources, archiveSource{path: path, name: filepath.Base(path), info: info})
	}
	if len(sources) == 0 {
		return nil, errPath
	}
	return sources, nil
}

func archiveFilename(sources []archiveSource) string {
	if len(sources) == 1 {
		return sources[0].name + ".zip"
	}
	parent := filepath.Dir(sources[0].path)
	for _, source := range sources[1:] {
		if filepath.Dir(source.path) != parent {
			return "archive.zip"
		}
	}
	if base := filepath.Base(parent); base != "/" && base != "." {
		return base + ".zip"
	}
	return "archive.zip"
}

// writeArchiveTree never follows symlinks, so a link cycle cannot stall the
// download. Special files are skipped because reading them could block.
func writeArchiveTree(ctx context.Context, writer *zip.Writer, path, name string, info fs.FileInfo) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	switch fileKind(info.Mode()) {
	case "directory":
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = name + "/"
		header.Method = zip.Deflate
		if _, err := writer.CreateHeader(header); err != nil {
			return err
		}
		children, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		for _, child := range children {
			childInfo, err := child.Info()
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			if err := writeArchiveTree(ctx, writer, filepath.Join(path, child.Name()), name+"/"+child.Name(), childInfo); err != nil {
				return err
			}
		}
		return nil
	case "file":
		file, err := os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		actual, err := file.Stat()
		if err != nil || !actual.Mode().IsRegular() {
			_ = file.Close()
			if err != nil {
				return err
			}
			return errType
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			_ = file.Close()
			return err
		}
		header.Name = name
		header.Method = zip.Deflate
		target, err := writer.CreateHeader(header)
		if err != nil {
			_ = file.Close()
			return err
		}
		_, copyErr := io.Copy(target, contextReader{ctx, file})
		return errors.Join(copyErr, file.Close())
	case "symlink":
		link, err := os.Readlink(path)
		if err != nil {
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = name
		header.Method = zip.Store
		target, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		_, err = io.WriteString(target, link)
		return err
	default:
		return nil
	}
}

func downloadArchive(w http.ResponseWriter, r *http.Request) {
	sources, err := archiveSources(r.URL.Query()["path"])
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": archiveFilename(sources)}))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	writer := zip.NewWriter(w)
	for _, source := range sources {
		if err := writeArchiveTree(r.Context(), writer, source.path, source.name, source.info); err != nil {
			// The status line is already sent; abort so the client sees a
			// truncated transfer instead of a seemingly complete archive.
			panic(http.ErrAbortHandler)
		}
	}
	if err := writer.Close(); err != nil {
		panic(http.ErrAbortHandler)
	}
}

func (s *server) compressArchive(w http.ResponseWriter, r *http.Request) {
	var form struct {
		Paths       []string `json:"paths"`
		Destination string   `json:"destination"`
		Conflict    string   `json:"conflict"`
	}
	if !readJSON(w, r, &form) {
		return
	}
	sources, err := archiveSources(form.Paths)
	if err != nil {
		failure(w, err)
		return
	}
	destination, err := pathOf(form.Destination)
	if err != nil {
		failure(w, err)
		return
	}
	if form.Conflict != "" && form.Conflict != "skip" && form.Conflict != "keep" {
		failure(w, errPath)
		return
	}
	if info, err := os.Lstat(destination); err == nil && info.IsDir() {
		failure(w, errPath)
		return
	}
	parent := filepath.Dir(destination)
	parentInfo, err := os.Stat(parent)
	if err != nil {
		failure(w, err)
		return
	}
	if !parentInfo.IsDir() {
		failure(w, errPath)
		return
	}

	s.mutations.Lock()
	defer s.mutations.Unlock()
	temp, err := os.CreateTemp(parent, ".godesk-*.zip")
	if err != nil {
		failure(w, err)
		return
	}
	tempPath := temp.Name()
	discard := func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}
	writer := zip.NewWriter(temp)
	for _, source := range sources {
		if err := writeArchiveTree(r.Context(), writer, source.path, source.name, source.info); err != nil {
			_ = writer.Close()
			discard()
			failure(w, err)
			return
		}
	}
	if err := writer.Close(); err != nil {
		discard()
		failure(w, err)
		return
	}
	if err := temp.Close(); err != nil {
		discard()
		failure(w, err)
		return
	}
	conflict := ""
	if form.Conflict == "keep" {
		conflict = "keep"
	}
	outcome, err := chooseTarget(destination, conflict, false, func(path string) error {
		return renameExclusive(tempPath, path)
	})
	if err != nil {
		_ = os.Remove(tempPath)
		failure(w, err)
		return
	}
	jsonResponse(w, struct {
		Path string `json:"path"`
	}{outcome.Path})
}

func archiveFormat(path string) (string, bool) {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return "zip", true
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return "targz", true
	case strings.HasSuffix(lower, ".tar"):
		return "tar", true
	default:
		return "", false
	}
}

func archiveStem(name string) string {
	lower := strings.ToLower(name)
	for _, suffix := range []string{".tar.gz", ".tgz", ".tar", ".zip"} {
		if strings.HasSuffix(lower, suffix) {
			if stem := name[:len(name)-len(suffix)]; stem != "" {
				return stem
			}
			break
		}
	}
	return "archive"
}

func (s *server) extractArchive(w http.ResponseWriter, r *http.Request) {
	var form struct {
		Path        string `json:"path"`
		Destination string `json:"destination"`
		Mode        string `json:"mode"`
		Conflict    string `json:"conflict"`
	}
	if !readJSON(w, r, &form) {
		return
	}
	path, err := pathOf(form.Path)
	if err != nil {
		failure(w, err)
		return
	}
	format, ok := archiveFormat(path)
	if !ok {
		failure(w, errType)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		failure(w, err)
		return
	}
	if !info.Mode().IsRegular() {
		failure(w, errType)
		return
	}
	destination := filepath.Dir(path)
	if form.Destination != "" {
		destination, err = pathOf(form.Destination)
		if err != nil {
			failure(w, err)
			return
		}
	}
	destinationInfo, err := os.Stat(destination)
	if err != nil {
		failure(w, err)
		return
	}
	if !destinationInfo.IsDir() {
		failure(w, errPath)
		return
	}
	mode, conflict := form.Mode, form.Conflict
	if mode == "" {
		mode = "here"
	}
	if (mode != "here" && mode != "folder") ||
		(conflict != "" && conflict != "skip" && conflict != "keep") {
		failure(w, errPath)
		return
	}

	s.mutations.Lock()
	defer s.mutations.Unlock()

	root, created := destination, ""
	if mode == "folder" {
		target := filepath.Join(destination, archiveStem(filepath.Base(path)))
		_, statErr := os.Lstat(target)
		existing := statErr == nil
		if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
			failure(w, statErr)
			return
		}
		if existing {
			switch conflict {
			case "keep":
				for n := 1; ; n++ {
					candidate := numbered(target, n, true)
					if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
						target, existing = candidate, false
						break
					} else if err != nil {
						failure(w, err)
						return
					}
				}
			case "skip":
				// Extract into the existing folder and skip its conflicts.
			default:
				failure(w, fs.ErrExist)
				return
			}
		}
		if existing {
			existingInfo, err := os.Stat(target)
			if err != nil {
				failure(w, err)
				return
			}
			if !existingInfo.IsDir() {
				failure(w, fs.ErrExist)
				return
			}
		} else if err := os.Mkdir(target, 0777); err != nil {
			failure(w, err)
			return
		} else {
			created = target
		}
		root = target
	}

	counts, err := extractArchiveFile(r.Context(), path, format, root, conflict)
	if err != nil {
		if created != "" {
			discardStage(created)
		}
		failure(w, err)
		return
	}
	jsonResponse(w, struct {
		Destination string `json:"destination"`
		Extracted   int    `json:"extracted"`
		Skipped     int    `json:"skipped"`
	}{root, counts.extracted, counts.skipped})
}

type extractCounts struct {
	extracted int
	skipped   int
}

type extractedDir struct {
	path    string
	mode    fs.FileMode
	modTime time.Time
}

type archiveMember struct {
	name    string
	kind    string
	mode    fs.FileMode
	modTime time.Time
	link    string
	body    io.Reader
}

type extractor struct {
	ctx         context.Context
	root        string
	conflict    string
	counts      extractCounts
	directories []extractedDir
	skippedDirs map[string]bool
}

func extractArchiveFile(ctx context.Context, path, format, root, conflict string) (extractCounts, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return extractCounts{}, err
	}
	defer file.Close()
	if err := ctx.Err(); err != nil {
		return extractCounts{}, err
	}
	x := &extractor{ctx: ctx, root: root, conflict: conflict, skippedDirs: make(map[string]bool)}
	switch format {
	case "zip":
		info, err := file.Stat()
		if err != nil {
			return extractCounts{}, err
		}
		reader, err := zip.NewReader(file, info.Size())
		if err != nil {
			return extractCounts{}, archiveError(err)
		}
		err = extractZip(ctx, reader, x)
		if err != nil {
			return extractCounts{}, err
		}
	case "tar":
		if err := extractTar(ctx, tar.NewReader(file), x); err != nil {
			return extractCounts{}, err
		}
	case "targz":
		reader, err := gzip.NewReader(file)
		if err != nil {
			return extractCounts{}, archiveError(err)
		}
		defer reader.Close()
		if err := extractTar(ctx, tar.NewReader(reader), x); err != nil {
			return extractCounts{}, err
		}
	default:
		return extractCounts{}, errType
	}
	x.finish()
	return x.counts, nil
}

func archiveError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fmt.Errorf("%w: %v", errArchive, err)
}

func extractZip(ctx context.Context, reader *zip.Reader, x *extractor) error {
	for _, file := range reader.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		info := file.FileInfo()
		member := archiveMember{name: file.Name, kind: fileKind(info.Mode()), mode: info.Mode(), modTime: info.ModTime()}
		var body io.ReadCloser
		switch member.kind {
		case "file":
			var err error
			if body, err = file.Open(); err != nil {
				return archiveError(err)
			}
			member.body = body
		case "symlink":
			var err error
			if body, err = file.Open(); err != nil {
				return archiveError(err)
			}
			link, err := io.ReadAll(io.LimitReader(body, 4096))
			if err != nil {
				_ = body.Close()
				return archiveError(err)
			}
			member.link = string(link)
		}
		err := x.add(member)
		if body != nil {
			err = errors.Join(err, body.Close())
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func extractTar(ctx context.Context, reader *tar.Reader, x *extractor) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return archiveError(err)
		}
		member := archiveMember{name: header.Name, mode: header.FileInfo().Mode(), modTime: header.ModTime}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA:
			member.kind, member.body = "file", reader
		case tar.TypeDir:
			member.kind = "directory"
		case tar.TypeSymlink:
			member.kind, member.link = "symlink", header.Linkname
		case tar.TypeLink:
			member.kind, member.link = "hardlink", header.Linkname
		default:
			member.kind = "special"
		}
		if err := x.add(member); err != nil {
			return err
		}
	}
}

func (x *extractor) add(member archiveMember) error {
	if err := x.ctx.Err(); err != nil {
		return err
	}
	name, target, err := x.resolve(member.name)
	if err != nil {
		return err
	}
	if name == "" {
		// The archive's own root directory entry.
		return nil
	}
	if x.skippedParent(name) {
		x.counts.skipped++
		return nil
	}
	switch member.kind {
	case "directory":
		return x.directory(name, target, member)
	case "file":
		return x.file(target, member)
	case "symlink":
		return x.symlink(target, member)
	case "hardlink":
		return x.hardlink(target, member)
	default:
		x.counts.skipped++
		return nil
	}
}

// resolve normalizes an archive member name into a path confined to the target
// root and rejects absolute names, ".." escapes and symlinked parent folders.
func (x *extractor) resolve(name string) (string, string, error) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", "", errArchive
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return "", "", errTraversal
	}
	cleaned := filepath.Clean(name)
	if cleaned == "." {
		return "", "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", "", errTraversal
	}
	target := filepath.Join(x.root, cleaned)
	inside, err := underRoot(x.root, target)
	if err != nil {
		return "", "", err
	}
	if !inside {
		return "", "", errTraversal
	}
	if err := checkParents(x.root, cleaned); err != nil {
		return "", "", err
	}
	return cleaned, target, nil
}

func underRoot(root, target string) (bool, error) {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false, errArchive
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false, nil
	}
	return true, nil
}

func checkParents(root, rel string) error {
	parent := filepath.Dir(rel)
	if parent == "." {
		return nil
	}
	current := root
	for _, part := range strings.Split(parent, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return errTraversal
		}
		if !info.IsDir() {
			return errArchive
		}
	}
	return nil
}

func (x *extractor) skippedParent(rel string) bool {
	for parent := filepath.Dir(rel); parent != "."; parent = filepath.Dir(parent) {
		if x.skippedDirs[parent] {
			return true
		}
	}
	return false
}

func (x *extractor) directory(rel, target string, member archiveMember) error {
	info, err := os.Lstat(target)
	switch {
	case err == nil && info.IsDir():
		x.counts.skipped++
		return nil
	case err == nil:
		if x.conflict == "skip" {
			x.skippedDirs[rel] = true
			x.counts.skipped++
			return nil
		}
		return fs.ErrExist
	case !errors.Is(err, fs.ErrNotExist):
		return err
	}
	if err := os.MkdirAll(target, 0700); err != nil {
		return err
	}
	x.counts.extracted++
	x.directories = append(x.directories, extractedDir{target, member.mode.Perm(), member.modTime})
	return nil
}

// available applies the skip/keep contract to an existing target. It returns
// the path to create and whether the entry should be skipped.
func (x *extractor) available(target string) (string, bool, error) {
	_, err := os.Lstat(target)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return target, false, nil
	case err != nil:
		return "", false, err
	case x.conflict == "skip":
		return "", true, nil
	case x.conflict == "keep":
		for n := 1; ; n++ {
			candidate := numbered(target, n, false)
			if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
				return candidate, false, nil
			} else if err != nil {
				return "", false, err
			}
		}
	default:
		return "", false, fs.ErrExist
	}
}

func (x *extractor) file(target string, member archiveMember) error {
	target, skipped, err := x.available(target)
	if err != nil || skipped {
		if skipped {
			x.counts.skipped++
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	handle, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(handle, contextReader{x.ctx, member.body})
	if err := errors.Join(copyErr, handle.Close()); err != nil {
		_ = os.Remove(target)
		return err
	}
	if perm := member.mode.Perm(); perm != 0 {
		_ = os.Chmod(target, perm)
	}
	if !member.modTime.IsZero() {
		_ = os.Chtimes(target, member.modTime, member.modTime)
	}
	x.counts.extracted++
	return nil
}

func (x *extractor) symlink(target string, member archiveMember) error {
	if _, err := x.linkTarget(target, member.link); err != nil {
		return err
	}
	target, skipped, err := x.available(target)
	if err != nil || skipped {
		if skipped {
			x.counts.skipped++
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	if err := os.Symlink(member.link, target); err != nil {
		return err
	}
	x.counts.extracted++
	return nil
}

func (x *extractor) hardlink(target string, member archiveMember) error {
	if member.link == "" {
		return errArchive
	}
	if filepath.IsAbs(member.link) || strings.HasPrefix(member.link, "/") {
		return errTraversal
	}
	source := filepath.Join(x.root, filepath.Clean(member.link))
	if inside, err := underRoot(x.root, source); err != nil || !inside {
		return errTraversal
	}
	if _, err := os.Lstat(source); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			x.counts.skipped++
			return nil
		}
		return err
	}
	target, skipped, err := x.available(target)
	if err != nil || skipped {
		if skipped {
			x.counts.skipped++
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	if err := os.Link(source, target); err != nil {
		return err
	}
	x.counts.extracted++
	return nil
}

// linkTarget validates a symlink target so it cannot point outside the root.
func (x *extractor) linkTarget(target, link string) (string, error) {
	if link == "" || strings.ContainsRune(link, 0) {
		return "", errArchive
	}
	if filepath.IsAbs(link) || strings.HasPrefix(link, "/") {
		return "", errTraversal
	}
	resolved := filepath.Join(filepath.Dir(target), link)
	inside, err := underRoot(x.root, resolved)
	if err != nil || !inside {
		return "", errTraversal
	}
	return resolved, nil
}

func (x *extractor) finish() {
	for i := len(x.directories) - 1; i >= 0; i-- {
		directory := x.directories[i]
		if directory.mode != 0 {
			_ = os.Chmod(directory.path, directory.mode)
		}
		if !directory.modTime.IsZero() {
			_ = os.Chtimes(directory.path, directory.modTime, directory.modTime)
		}
	}
}
