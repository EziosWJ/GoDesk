package files

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func differentGroup(t *testing.T, path string) int {
	t.Helper()
	current := ownershipStat(t, path).Gid
	groups, err := os.Getgroups()
	if err != nil {
		t.Fatal(err)
	}
	groups = append(groups, os.Getegid())
	if os.Geteuid() == 0 {
		groups = append(groups, int(current)^1)
	}
	probe := filepath.Join(t.TempDir(), "probe")
	mustWrite(t, probe, "")
	for _, gid := range groups {
		if uint32(gid) == current {
			continue
		}
		if err := os.Chown(probe, -1, gid); err == nil {
			return gid
		} else if !errors.Is(err, fs.ErrPermission) && !errors.Is(err, unix.EINVAL) {
			t.Fatal(err)
		}
	}
	t.Skip("test requires another permitted file group")
	return -1
}

func ownershipStat(t *testing.T, path string) *syscall.Stat_t {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t)
}

func TestDirectoryPermissionLabels(t *testing.T) {
	for _, test := range []struct {
		mode fs.FileMode
		want string
	}{
		{0644, "-rw-r--r--"},
		{fs.ModeDir | fs.ModeSetgid | fs.ModeSticky | 0770, "drwxrws--T"},
		{fs.ModeSetuid | 0640, "-rwSr-----"},
		{fs.ModeCharDevice | fs.ModeDevice | 0600, "crw-------"},
		{fs.ModeNamedPipe | 0600, "prw-------"},
	} {
		if got := permissionLabel(test.mode); got != test.want {
			t.Errorf("mode %v: got %q, want %q", test.mode, got, test.want)
		}
	}
	root := t.TempDir()
	if err := os.Symlink("missing", filepath.Join(root, "broken")); err != nil {
		t.Fatal(err)
	}
	response := request(t, testRoutes(), "GET", "/directory?path="+url.QueryEscape(root), "", nil, 200)
	var directory struct{ Entries []entry }
	if err := json.Unmarshal(response.Body.Bytes(), &directory); err != nil {
		t.Fatal(err)
	}
	if len(directory.Entries) != 1 {
		t.Fatalf("unexpected directory entries: %+v", directory.Entries)
	}
	link := directory.Entries[0]
	if link.Owner == "" || link.Group == "" || link.Permissions != "lrwxrwxrwx" || link.TargetError == "" {
		t.Fatalf("missing link metadata: %+v", link)
	}
}

func TestChangeLinkGroupWithoutFollowing(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	link := filepath.Join(root, "link")
	broken := filepath.Join(root, "broken")
	fifo := filepath.Join(root, "fifo")
	mustWrite(t, path, "original")
	for name, target := range map[string]string{link: path, broken: "missing"} {
		if err := os.Symlink(target, name); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	mux := testRoutes()
	sendJSON(t, mux, "PUT", "/ownership", map[string]string{"path": fifo, "group": strconv.Itoa(os.Getegid())}, 415)
	sendJSON(t, mux, "PUT", "/ownership", map[string]string{"path": path, "owner": "4294967295"}, 400)
	group := differentGroup(t, link)
	before := ownershipStat(t, path)
	for _, name := range []string{link, broken} {
		original := ownershipStat(t, name)
		sendJSON(t, mux, "PUT", "/ownership", map[string]string{"path": name, "group": strconv.Itoa(group)}, 200)
		if got := ownershipStat(t, name); got.Gid != uint32(group) || got.Uid != original.Uid {
			t.Fatalf("unexpected link ownership after group change: uid=%d gid=%d", got.Uid, got.Gid)
		}
	}
	if got := ownershipStat(t, path); before.Uid != got.Uid || before.Gid != got.Gid {
		t.Fatal("changing the link changed its target")
	}
}

func TestTextSavePreservesFileOwnership(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	mustWrite(t, path, "original")
	if err := os.Chown(path, -1, differentGroup(t, path)); err != nil {
		t.Fatal(err)
	}
	before := ownershipStat(t, path)
	original, _, err := readText(path)
	if err != nil {
		t.Fatal(err)
	}
	sendJSON(t, testRoutes(), "PUT", "/text", map[string]string{"path": path, "text": "updated", "version": original.Version}, 200)
	if got := ownershipStat(t, path); before.Uid != got.Uid || before.Gid != got.Gid {
		t.Fatalf("save changed ownership from %d:%d to %d:%d", before.Uid, before.Gid, got.Uid, got.Gid)
	}
	mustRead(t, path, "updated")
}

func TestChangePermissions(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "directory")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "file.txt")
	link := filepath.Join(root, "link")
	mustWrite(t, path, "original")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	mux := testRoutes()
	sendJSON(t, mux, "PUT", "/permissions", map[string]string{"path": link, "mode": "777"}, 415)
	sendJSON(t, mux, "PUT", "/permissions", map[string]string{"path": path, "mode": "0899"}, 400)
	sendJSON(t, mux, "PUT", "/permissions", map[string]string{"path": directory, "mode": "1750"}, 200)
	if got := ownershipStat(t, directory).Mode & 07777; got != 01750 {
		t.Fatalf("directory mode = %04o, want 1750", got)
	}
	if got := ownershipStat(t, path).Mode & 07777; got != 0600 {
		t.Fatalf("directory edit changed child mode to %04o", got)
	}
	for _, mode := range []string{"000", "1640"} {
		sendJSON(t, mux, "PUT", "/permissions", map[string]string{"path": path, "mode": mode}, 200)
	}
	original, _, err := readText(path)
	if err != nil {
		t.Fatal(err)
	}
	sendJSON(t, mux, "PUT", "/text", map[string]string{"path": path, "text": "updated", "version": original.Version}, 200)
	if got := ownershipStat(t, path).Mode & 07777; got != 01640 {
		t.Fatalf("save changed mode to %04o, want 1640", got)
	}
}
