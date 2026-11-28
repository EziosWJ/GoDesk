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
	// An existing directory is a conflict like any other occupied destination:
	// skip and keep resolve it through chooseTarget below. Only an unspecified
	// conflict policy rejects it up front.
	if info, err := os.Lstat(destination); err == nil && info.IsDir() && form.Conflict == "" {
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
	outcome, err := chooseTarget(destination, form.Conflict, false, func(path string) error {
		return renameExclusive(tempPath, path)
	})
	if err != nil {
		_ = os.Remove(tempPath)
		failure(w, err)
		return
	}
	if outcome.Skipped {
		// The existing archive is authoritative; discard the temporary output.
		_ = os.Remove(tempPath)
	}
	jsonResponse(w, struct {
		Path    string `json:"path"`
		Skipped bool   `json:"skipped,omitempty"`
	}{outcome.Path, outcome.Skipped})
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

// validArchiveStem rejects folder names that would escape the destination or
// resolve to the destination itself when mode is "folder".
func validArchiveStem(stem string) bool {
	return stem != "" && stem != "." && stem != ".." && !strings.ContainsAny(stem, "/\\\x00")
}

// extractionRoot picks the mode:"folder" target inside destRoot. A pre-existing
// symlink or regular file at that name is never followed or reused: keep picks
// a fresh numbered directory, and skip/default fail cleanly.
func extractionRoot(destRoot *os.Root, stem, conflict string) (string, bool, error) {
	info, err := destRoot.Lstat(stem)
	if errors.Is(err, fs.ErrNotExist) {
		return stem, false, nil
	}
	if err != nil {
		return "", false, err
	}
	if info.IsDir() {
		switch conflict {
		case "skip":
			return stem, true, nil
		case "keep":
			return availableExtractionDir(destRoot, stem)
		default:
			return "", false, fs.ErrExist
		}
	}
	// Lstat reports a symlink itself, so a link to a directory is not treated
	// as an existing folder.
	if conflict == "keep" {
		return availableExtractionDir(destRoot, stem)
	}
	return "", false, fs.ErrExist
}

func availableExtractionDir(destRoot *os.Root, stem string) (string, bool, error) {
	for n := 1; ; n++ {
		candidate := numbered(stem, n, true)
		_, err := destRoot.Lstat(candidate)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return candidate, false, nil
		case err != nil:
			return "", false, err
		}
	}
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

	// Pin the destination for the whole request so later path lookups cannot
	// escape through a replaced symlink.
	destRoot, err := os.OpenRoot(destination)
	if err != nil {
		failure(w, err)
		return
	}
	defer destRoot.Close()

	root := destination
	extractRoot := destRoot
	createdRoot := ""
	if mode == "folder" {
		stem := archiveStem(filepath.Base(path))
		if !validArchiveStem(stem) {
			failure(w, errPath)
			return
		}
		target, existing, err := extractionRoot(destRoot, stem, conflict)
		if err != nil {
			failure(w, err)
			return
		}
		if !existing {
			if err := destRoot.Mkdir(target, 0777); err != nil {
				failure(w, err)
				return
			}
			createdRoot = target
		}
		extractRoot, err = destRoot.OpenRoot(target)
		if err != nil {
			if createdRoot != "" {
				_ = destRoot.Remove(createdRoot)
			}
			failure(w, err)
			return
		}
		defer extractRoot.Close()
		root = filepath.Join(destination, target)
	}

	counts, err := extractArchiveFile(r.Context(), path, format, extractRoot, conflict)
	if err != nil {
		if createdRoot != "" {
			_ = destRoot.Remove(createdRoot)
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
	rel     string
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

// createdEntry records one filesystem object created by this request so it can
// be rolled back if a later entry fails or the request is canceled.
type createdEntry struct {
	rel  string
	kind string
}

type extractor struct {
	ctx         context.Context
	root        *os.Root
	conflict    string
	counts      extractCounts
	directories []extractedDir
	skippedDirs map[string]bool
	renamedDirs map[string]string
	created     []createdEntry
}

func extractArchiveFile(ctx context.Context, path, format string, root *os.Root, conflict string) (extractCounts, error) {
	x := &extractor{
		ctx: ctx, root: root, conflict: conflict,
		skippedDirs: make(map[string]bool), renamedDirs: make(map[string]string),
	}
	file, err := os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return extractCounts{}, err
	}
	defer file.Close()
	if err := ctx.Err(); err != nil {
		return extractCounts{}, err
	}
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
		if err := extractZip(ctx, reader, x); err != nil {
			x.rollback()
			return extractCounts{}, err
		}
	case "tar":
		if err := extractTar(ctx, tar.NewReader(file), x); err != nil {
			x.rollback()
			return extractCounts{}, err
		}
	case "targz":
		reader, err := gzip.NewReader(file)
		if err != nil {
			return extractCounts{}, archiveError(err)
		}
		defer reader.Close()
		if err := extractTar(ctx, tar.NewReader(reader), x); err != nil {
			x.rollback()
			return extractCounts{}, err
		}
		// tar.Reader stops at the tar EOF blocks, before gzip verifies its
		// CRC32/ISIZE trailer. Drain the stream so corrupt or truncated gzip
		// data is still reported and rolled back.
		if err := drainGzip(ctx, reader); err != nil {
			x.rollback()
			return extractCounts{}, err
		}
	default:
		return extractCounts{}, errType
	}
	x.finish()
	return x.counts, nil
}

// drainGzip reads the remainder of a gzip stream to EOF, which makes gzip
// validate the trailer. The size bound rejects archives that hide unbounded
// data after the tar EOF blocks.
func drainGzip(ctx context.Context, reader io.Reader) error {
	const limit = 1 << 20
	buffer := make([]byte, 32<<10)
	total := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := reader.Read(buffer)
		total += n
		if errors.Is(err, io.EOF) {
			if total > limit {
				return fmt.Errorf("%w: 归档尾部数据过多", errArchive)
			}
			return nil
		}
		if err != nil {
			return archiveError(err)
		}
		if total > limit {
			return fmt.Errorf("%w: 归档尾部数据过多", errArchive)
		}
	}
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
	rel, err := x.resolve(member.name)
	if err != nil {
		return err
	}
	if rel == "" {
		// The archive's own root directory entry.
		return nil
	}
	rel = x.remap(rel)
	if x.skippedParent(rel) {
		x.counts.skipped++
		return nil
	}
	rel, skipped, err := x.prepare(rel)
	if err != nil {
		return err
	}
	if skipped {
		x.counts.skipped++
		return nil
	}
	switch member.kind {
	case "directory":
		return x.directory(rel, member)
	case "file":
		return x.file(rel, member)
	case "symlink":
		return x.symlink(rel, member)
	case "hardlink":
		return x.hardlink(rel, member)
	default:
		x.counts.skipped++
		return nil
	}
}

// resolve normalizes an archive member name into a path relative to the
// extraction root and rejects absolute names, NUL bytes and ".." escapes.
func (x *extractor) resolve(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", errArchive
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return "", errTraversal
	}
	cleaned := filepath.Clean(name)
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errTraversal
	}
	return cleaned, nil
}

// remap applies directory renames chosen under conflict:"keep" so descendants
// of a renamed directory are written beside the renamed directory.
func (x *extractor) remap(rel string) string {
	for range len(x.renamedDirs) + 1 {
		matched, renamed := "", ""
		for original, actual := range x.renamedDirs {
			prefix := original + string(filepath.Separator)
			if (rel == original || strings.HasPrefix(rel, prefix)) && len(original) > len(matched) {
				matched, renamed = original, actual
			}
		}
		if matched == "" {
			return rel
		}
		rel = renamed + rel[len(matched):]
	}
	return rel
}

// prepare ensures every parent of rel is a real directory inside the root,
// never traversing a symlink. A parent blocked by a non-directory follows the
// same conflict policy as files: skip skips this entry, keep renames the
// blocking directory and remaps the entry below it.
func (x *extractor) prepare(rel string) (string, bool, error) {
	parent := filepath.Dir(rel)
	if parent == "." {
		return rel, false, nil
	}
	current := ""
	for _, part := range strings.Split(parent, string(filepath.Separator)) {
		if current == "" {
			current = part
		} else {
			current += string(filepath.Separator) + part
		}
		info, err := x.root.Lstat(current)
		switch {
		case err == nil && info.IsDir():
			continue
		case err == nil:
			if info.Mode()&fs.ModeSymlink != 0 {
				return "", false, errTraversal
			}
			switch x.conflict {
			case "skip":
				x.skippedDirs[current] = true
				return "", true, nil
			case "keep":
				renamed, err := x.createRenamedDir(current)
				if err != nil {
					return "", false, err
				}
				x.renamedDirs[current] = renamed
				return x.prepare(renamed + rel[len(current):])
			default:
				return "", false, fs.ErrExist
			}
		case errors.Is(err, fs.ErrNotExist):
			if err := x.root.Mkdir(current, 0700); err != nil {
				return "", false, err
			}
			x.created = append(x.created, createdEntry{rel: current, kind: "directory"})
		default:
			return "", false, err
		}
	}
	return rel, false, nil
}

// createRenamedDir creates a fresh numbered directory beside base and records
// it for rollback.
func (x *extractor) createRenamedDir(base string) (string, error) {
	for n := 1; ; n++ {
		candidate := numbered(base, n, true)
		_, err := x.root.Lstat(candidate)
		switch {
		case err == nil:
			continue
		case !errors.Is(err, fs.ErrNotExist):
			return "", err
		}
		if err := x.root.Mkdir(candidate, 0700); err != nil {
			return "", err
		}
		x.created = append(x.created, createdEntry{rel: candidate, kind: "directory"})
		return candidate, nil
	}
}

func (x *extractor) skippedParent(rel string) bool {
	for parent := filepath.Dir(rel); parent != "."; parent = filepath.Dir(parent) {
		if x.skippedDirs[parent] {
			return true
		}
	}
	return false
}

func (x *extractor) directory(rel string, member archiveMember) error {
	info, err := x.root.Lstat(rel)
	switch {
	case err == nil && info.IsDir():
		x.counts.skipped++
		return nil
	case err == nil:
		// A symlink (even one pointing at a directory) or regular file blocks
		// the directory path; never follow or replace it.
		switch x.conflict {
		case "skip":
			x.skippedDirs[rel] = true
			x.counts.skipped++
			return nil
		case "keep":
			renamed, err := x.createRenamedDir(rel)
			if err != nil {
				return err
			}
			x.renamedDirs[rel] = renamed
			x.counts.extracted++
			x.directories = append(x.directories, extractedDir{renamed, member.mode.Perm(), member.modTime})
			return nil
		default:
			return fs.ErrExist
		}
	case !errors.Is(err, fs.ErrNotExist):
		return err
	}
	if err := x.root.Mkdir(rel, 0700); err != nil {
		return err
	}
	x.created = append(x.created, createdEntry{rel: rel, kind: "directory"})
	x.counts.extracted++
	x.directories = append(x.directories, extractedDir{rel, member.mode.Perm(), member.modTime})
	return nil
}

// available applies the skip/keep contract to an existing target. It returns
// the path to create and whether the entry should be skipped.
func (x *extractor) available(rel string) (string, bool, error) {
	_, err := x.root.Lstat(rel)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return rel, false, nil
	case err != nil:
		return "", false, err
	case x.conflict == "skip":
		return "", true, nil
	case x.conflict == "keep":
		for n := 1; ; n++ {
			candidate := numbered(rel, n, false)
			if _, err := x.root.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
				return candidate, false, nil
			} else if err != nil {
				return "", false, err
			}
		}
	default:
		return "", false, fs.ErrExist
	}
}

func (x *extractor) file(rel string, member archiveMember) error {
	target, skipped, err := x.available(rel)
	if err != nil {
		return err
	}
	if skipped {
		x.counts.skipped++
		return nil
	}
	handle, err := x.root.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	x.created = append(x.created, createdEntry{rel: target, kind: "file"})
	_, copyErr := io.Copy(handle, contextReader{x.ctx, member.body})
	if err := errors.Join(copyErr, handle.Close()); err != nil {
		return err
	}
	if perm := member.mode.Perm(); perm != 0 {
		_ = x.root.Chmod(target, perm)
	}
	if !member.modTime.IsZero() {
		_ = x.root.Chtimes(target, member.modTime, member.modTime)
	}
	x.counts.extracted++
	return nil
}

func (x *extractor) symlink(rel string, member archiveMember) error {
	if err := x.linkTarget(rel, member.link); err != nil {
		return err
	}
	target, skipped, err := x.available(rel)
	if err != nil {
		return err
	}
	if skipped {
		x.counts.skipped++
		return nil
	}
	// Store the normalized target: the raw header value may contain "./" or
	// ".." segments that linkTarget already validated as non-escaping.
	if err := x.root.Symlink(filepath.Clean(member.link), target); err != nil {
		return err
	}
	x.created = append(x.created, createdEntry{rel: target, kind: "symlink"})
	x.counts.extracted++
	return nil
}

func (x *extractor) hardlink(rel string, member archiveMember) error {
	if member.link == "" || strings.ContainsRune(member.link, 0) {
		return errArchive
	}
	if filepath.IsAbs(member.link) || strings.HasPrefix(member.link, "/") {
		return errTraversal
	}
	source := filepath.Clean(member.link)
	if source == "." || source == ".." || strings.HasPrefix(source, ".."+string(filepath.Separator)) {
		return errTraversal
	}
	source = x.remap(source)
	if x.skippedParent(source) {
		x.counts.skipped++
		return nil
	}
	if err := x.checkParentLinks(source); err != nil {
		return err
	}
	info, err := x.root.Lstat(source)
	if errors.Is(err, fs.ErrNotExist) {
		x.counts.skipped++
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		// Hard links may only reference a regular file reached without
		// following a symlink; otherwise confinement cannot be guaranteed.
		return errTraversal
	}
	target, skipped, err := x.available(rel)
	if err != nil {
		return err
	}
	if skipped {
		x.counts.skipped++
		return nil
	}
	if err := x.root.Link(source, target); err != nil {
		return err
	}
	x.created = append(x.created, createdEntry{rel: target, kind: "hardlink"})
	x.counts.extracted++
	return nil
}

// checkParentLinks rejects hardlink sources reached through a symlinked parent
// inside the extraction root.
func (x *extractor) checkParentLinks(rel string) error {
	parent := filepath.Dir(rel)
	if parent == "." {
		return nil
	}
	current := ""
	for _, part := range strings.Split(parent, string(filepath.Separator)) {
		if current == "" {
			current = part
		} else {
			current += string(filepath.Separator) + part
		}
		info, err := x.root.Lstat(current)
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

// linkTarget validates a symlink target relative to the link's parent so it
// cannot point outside the extraction root.
func (x *extractor) linkTarget(rel, link string) error {
	if link == "" || strings.ContainsRune(link, 0) {
		return errArchive
	}
	if filepath.IsAbs(link) || strings.HasPrefix(link, "/") {
		return errTraversal
	}
	resolved := filepath.Join(filepath.Dir(rel), link)
	if resolved == ".." || strings.HasPrefix(resolved, ".."+string(filepath.Separator)) || filepath.IsAbs(resolved) {
		return errTraversal
	}
	return nil
}

// rollback removes everything this request created, in reverse creation order,
// leaving all pre-existing entries untouched.
func (x *extractor) rollback() {
	for i := len(x.created) - 1; i >= 0; i-- {
		_ = x.root.Remove(x.created[i].rel)
	}
}

func (x *extractor) finish() {
	for i := len(x.directories) - 1; i >= 0; i-- {
		directory := x.directories[i]
		if directory.mode != 0 {
			_ = x.root.Chmod(directory.rel, directory.mode)
		}
		if !directory.modTime.IsZero() {
			_ = x.root.Chtimes(directory.rel, directory.modTime, directory.modTime)
		}
	}
}
