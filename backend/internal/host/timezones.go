package host

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
)

const zoneinfoRoot = "/usr/share/zoneinfo"

// Timezones lists the IANA zone names installed under /usr/share/zoneinfo.
// It returns UTC when the database is missing.
func Timezones() []string {
	return availableTimezones(zoneinfoRoot)
}

func availableTimezones(root string) []string {
	seen := make(map[string]struct{})
	zones := make([]string, 0, 512)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Skip unreadable entries; a partial listing is still useful.
			if path == root {
				return walkErr
			}
			return nil
		}
		if path == root {
			return nil
		}
		name := entry.Name()
		if entry.IsDir() {
			if skippedZoneDir(name) {
				return filepath.SkipDir
			}
			return nil
		}
		if skippedZoneFile(name) {
			return nil
		}
		if !entry.Type().IsRegular() && entry.Type()&fs.ModeSymlink == 0 {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		zone := filepath.ToSlash(relative)
		if _, ok := seen[zone]; ok {
			return nil
		}
		seen[zone] = struct{}{}
		zones = append(zones, zone)
		return nil
	})
	if err != nil || len(zones) == 0 {
		return []string{"UTC"}
	}
	sort.Strings(zones)
	return zones
}

func skippedZoneDir(name string) bool {
	// Etc/ contains valid installed zones such as Etc/UTC and Etc/GMT+8, so it
	// is included. posix/ and right/ duplicate the tree with different leap
	// second handling and are not valid IANA names for timedatectl.
	switch name {
	case "posix", "right":
		return true
	}
	return false
}

func skippedZoneFile(name string) bool {
	if strings.HasSuffix(name, ".tab") {
		return true
	}
	switch name {
	case "leapseconds", "leap-seconds.list", "tzdata.zi", "SECURITY", "localtime", "posixrules":
		return true
	}
	return false
}

// validTimezoneFormat checks the shape of a zone name before it is compared
// with the installed list. It keeps values from escaping the zoneinfo tree or
// being interpreted as a command option.
func validTimezoneFormat(timezone string) bool {
	return cleanZonePath(timezone) != ""
}
