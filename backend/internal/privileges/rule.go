package privileges

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const ruleDir = "/etc/sudoers.d"
const ruleName = "godesk"
const ruleHeader = "# Managed by goDesk\n"
const ruleGrant = " ALL=(root) NOPASSWD: ALL\n"

const rulePath = ruleDir + "/" + ruleName

var invalidRule = errors.New("托管规则的内容、归属或权限无效")

func ruleFor(uid string) string {
	return ruleHeader + "#" + uid + ruleGrant
}

func ordinaryUID(uid string) bool {
	n, err := strconv.ParseUint(uid, 10, 32)
	return err == nil && n > 0 && n < 1<<32-1 && strconv.FormatUint(n, 10) == uid
}

func sudoCaller() (string, error) {
	name, uid := os.Getenv("SUDO_USER"), os.Getenv("SUDO_UID")
	if name == "" || name == "root" || !ordinaryUID(uid) {
		return "", errors.New("无法识别通过 sudo 发起调用的普通账号")
	}
	account, err := user.Lookup(name)
	if err != nil || account.Username != name || account.Uid != uid {
		return "", errors.New("sudo 调用者与主机账号记录不一致")
	}
	return uid, nil
}

func readRule() (string, error) {
	fd, err := unix.Open(rulePath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, unix.ELOOP) {
		return "", invalidRule
	}
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(fd), rulePath)
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return "", err
	}
	if stat.Mode != unix.S_IFREG|0440 || stat.Uid != 0 || stat.Gid != 0 {
		return "", invalidRule
	}
	data, err := io.ReadAll(io.LimitReader(file, 1024))
	if err != nil {
		return "", err
	}
	uid, ok := strings.CutPrefix(string(data), ruleHeader+"#")
	uid, complete := strings.CutSuffix(uid, ruleGrant)
	if !ok || !complete || !ordinaryUID(uid) {
		return "", invalidRule
	}
	return uid, nil
}

func withRuleLock(change func() error) error {
	if os.Geteuid() != 0 {
		return errors.New("此命令需要 root 权限")
	}
	fd, err := unix.Open(ruleDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("打开 %s: %w", ruleDir, err)
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Uid != 0 || stat.Mode&0022 != 0 {
		return fmt.Errorf("%s 须由 root 所有且仅允许 root 写入", ruleDir)
	}
	if err := unix.Flock(fd, unix.LOCK_EX); err != nil {
		return fmt.Errorf("锁定 %s: %w", ruleDir, err)
	}
	return change()
}

func validate(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "/usr/sbin/visudo", args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("visudo 校验失败: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func validateLoaded(ctx context.Context, uid string) error {
	installed, err := readRule()
	if err != nil {
		return err
	}
	if installed != uid {
		return invalidRule
	}
	output, err := validate(ctx, "-c")
	if err != nil {
		return err
	}
	for line := range strings.Lines(output) {
		if strings.TrimSpace(line) == rulePath+": parsed OK" {
			return nil
		}
	}
	// visudo-rs validates included files but only names the main file on success.
	main, err := os.ReadFile("/etc/sudoers")
	if err != nil {
		return err
	}
	if directlyIncludesRule(string(main)) {
		return nil
	}
	return fmt.Errorf("系统 sudoers 未加载 %s", rulePath)
}

func directlyIncludesRule(sudoers string) bool {
	for line := range strings.Lines(sudoers) {
		fields := strings.Fields(line)
		if len(fields) < 2 || len(fields) > 2 && !strings.HasPrefix(fields[2], "#") {
			continue
		}
		path := strings.Trim(fields[1], `"`)
		switch fields[0] {
		case "@includedir", "#includedir":
			if strings.TrimRight(path, "/") == ruleDir {
				return true
			}
		case "@include", "#include":
			if path == rulePath {
				return true
			}
		}
	}
	return false
}

func Setup(ctx context.Context) error {
	return withRuleLock(func() error {
		uid, err := sudoCaller()
		if err != nil {
			return err
		}
		installed, err := readRule()
		switch {
		case err == nil && installed == uid:
			return validateLoaded(ctx, uid)
		case err == nil:
			return errors.New("GoDesk 托管规则已授权给其他账号")
		case !errors.Is(err, fs.ErrNotExist):
			return err
		}
		file, err := os.CreateTemp(ruleDir, ".godesk-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		defer file.Close()
		if _, err := file.WriteString(ruleFor(uid)); err != nil {
			return err
		}
		if err := file.Chown(0, 0); err != nil {
			return err
		}
		if err := file.Chmod(0440); err != nil {
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
		if _, err := validate(ctx, "-c", "-f", file.Name()); err != nil {
			return err
		}
		// Publish atomically without replacing a rule created outside goDesk.
		if err := os.Link(file.Name(), rulePath); err != nil {
			return err
		}
		if err := validateLoaded(ctx, uid); err != nil {
			return errors.Join(err, os.Remove(rulePath))
		}
		return nil
	})
}

func Remove() error {
	var caller string
	if os.Getenv("SUDO_USER") != "" || os.Getenv("SUDO_UID") != "" {
		var err error
		caller, err = sudoCaller()
		if err != nil {
			return err
		}
	}
	err := withRuleLock(func() error {
		uid, err := readRule()
		if err != nil {
			return err
		}
		if caller != "" && caller != uid {
			return errors.New("只能移除调用账号自己的 GoDesk 托管规则")
		}
		return os.Remove(rulePath)
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func Check(ctx context.Context, out io.Writer) error {
	probe := Probe(ctx)
	switch {
	case os.Geteuid() == 0:
		fmt.Fprintln(out, "当前已是 root")
	case probe == nil:
		fmt.Fprintln(out, "免密 root 命令探测成功")
	default:
		fmt.Fprintln(out, "免密 root 命令探测失败")
	}
	uid, err := readRule()
	switch {
	case errors.Is(err, fs.ErrNotExist):
		fmt.Fprintln(out, "GoDesk 托管规则：不存在")
	case errors.Is(err, invalidRule):
		fmt.Fprintln(out, "GoDesk 托管规则：异常")
	case err != nil:
		fmt.Fprintln(out, "GoDesk 托管规则：无法核实")
	case os.Geteuid() == 0:
		if err := validateLoaded(ctx, uid); err != nil {
			fmt.Fprintf(out, "GoDesk 托管规则：异常（%v）\n", err)
		} else {
			fmt.Fprintf(out, "GoDesk 托管规则：授权给 UID %s\n", uid)
		}
	case uid == strconv.Itoa(os.Geteuid()):
		fmt.Fprintln(out, "GoDesk 托管规则：本账号已授权")
	default:
		fmt.Fprintln(out, "GoDesk 托管规则：其他账号已授权")
	}
	return probe
}
