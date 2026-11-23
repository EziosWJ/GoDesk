package files

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

var (
	errAccount           = errors.New("无效的账号名称或数字 ID")
	errPreserveOwnership = errors.New("无法保留原文件的所有者或所属组")
	errPermissionMode    = errors.New("请输入三位或四位八进制权限，例如 644 或 0755")
)

type accountNames map[uint32]string

func (names accountNames) label(id uint32, lookup func(string) string) string {
	if name, ok := names[id]; ok {
		return name
	}
	number := strconv.FormatUint(uint64(id), 10)
	name := lookup(number)
	if name == "" {
		name = number
	}
	names[id] = name
	return name
}

func ownerName(id string) string {
	if account, err := user.LookupId(id); err == nil {
		return account.Username
	}
	return ""
}

func groupName(id string) string {
	if group, err := user.LookupGroupId(id); err == nil {
		return group.Name
	}
	return ""
}

func permissionLabel(mode fs.FileMode) string {
	label := []byte("-" + mode.Perm().String()[1:])
	switch {
	case mode.IsDir():
		label[0] = 'd'
	case mode&fs.ModeSymlink != 0:
		label[0] = 'l'
	case mode&fs.ModeNamedPipe != 0:
		label[0] = 'p'
	case mode&fs.ModeSocket != 0:
		label[0] = 's'
	case mode&fs.ModeCharDevice != 0:
		label[0] = 'c'
	case mode&fs.ModeDevice != 0:
		label[0] = 'b'
	case !mode.IsRegular():
		label[0] = '?'
	}
	for _, bit := range []struct {
		mode                  fs.FileMode
		position              int
		withoutExec, withExec byte
	}{
		{fs.ModeSetuid, 3, 'S', 's'},
		{fs.ModeSetgid, 6, 'S', 's'},
		{fs.ModeSticky, 9, 'T', 't'},
	} {
		if mode&bit.mode != 0 {
			if label[bit.position] == 'x' {
				label[bit.position] = bit.withExec
			} else {
				label[bit.position] = bit.withoutExec
			}
		}
	}
	return string(label)
}

func accountID(value *string, group bool) (int, error) {
	if value == nil {
		return -1, nil
	}
	input := strings.TrimSpace(*value)
	number := input
	if strings.Trim(input, "0123456789") != "" {
		if group {
			account, err := user.LookupGroup(input)
			if err != nil {
				return -1, fmt.Errorf("%w %q", errAccount, input)
			}
			number = account.Gid
		} else {
			account, err := user.Lookup(input)
			if err != nil {
				return -1, fmt.Errorf("%w %q", errAccount, input)
			}
			number = account.Uid
		}
	}
	id, err := strconv.ParseUint(number, 10, 32)
	if err != nil || id == uint64(^uint32(0)) {
		return -1, fmt.Errorf("%w %q", errAccount, input)
	}
	return int(id), nil
}

func openMetadata(path, operation string) (int, unix.Stat_t, error) {
	var stat unix.Stat_t
	fd, err := unix.Open(path, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, stat, &os.PathError{Op: operation, Path: path, Err: err}
	}
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return -1, stat, &os.PathError{Op: operation, Path: path, Err: err}
	}
	return fd, stat, nil
}

func changeOwnership(path string, uid, gid int) error {
	fd, stat, err := openMetadata(path, "chown")
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFREG, unix.S_IFDIR, unix.S_IFLNK:
	default:
		return errType
	}
	if (uid == -1 || uint32(uid) == stat.Uid) && (gid == -1 || uint32(gid) == stat.Gid) {
		return nil
	}
	if err := unix.Fchownat(fd, "", uid, gid, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "chown", Path: path, Err: err}
	}
	return nil
}

func changePermissions(path, input string) error {
	if len(input) < 3 || len(input) > 4 || strings.Trim(input, "01234567") != "" {
		return errPermissionMode
	}
	mode, err := strconv.ParseUint(input, 8, 12)
	if err != nil {
		return errPermissionMode
	}
	fd, stat, err := openMetadata(path, "chmod")
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFREG, unix.S_IFDIR:
	default:
		return errType
	}
	err = unix.Fchmodat(fd, "", uint32(mode), unix.AT_EMPTY_PATH)
	if errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EINVAL) {
		// Older kernels can reach the same open inode through procfs.
		err = unix.Chmod(fmt.Sprintf("/proc/self/fd/%d", fd), uint32(mode))
	}
	if err != nil {
		return &os.PathError{Op: "chmod", Path: path, Err: err}
	}
	return nil
}

func preserveOwnership(temp *os.File, original fs.FileInfo) error {
	info, err := temp.Stat()
	if err != nil {
		return err
	}
	current := info.Sys().(*syscall.Stat_t)
	want := original.Sys().(*syscall.Stat_t)
	uid, gid := -1, -1
	if want.Uid != current.Uid {
		uid = int(want.Uid)
	}
	if want.Gid != current.Gid {
		gid = int(want.Gid)
	}
	if uid != -1 || gid != -1 {
		if err := temp.Chown(uid, gid); err != nil {
			return fmt.Errorf("%w：%w", errPreserveOwnership, err)
		}
	}
	return nil
}
