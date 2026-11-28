package buildinfo

import "testing"

func TestFormat(t *testing.T) {
	version, commit, date := Version, Commit, Date
	t.Cleanup(func() {
		Version, Commit, Date = version, commit, date
	})

	tests := []struct {
		name    string
		version string
		commit  string
		date    string
		want    string
	}{
		{name: "defaults", version: "dev", want: "dev"},
		{name: "empty version falls back", version: "", want: "dev"},
		{name: "full", version: "v0.1.0", commit: "abc1234", date: "2026-11-27T09:30:00Z", want: "v0.1.0 (abc1234, 2026-11-27T09:30:00Z)"},
		{name: "commit only", version: "v0.1.0", commit: "abc1234", want: "v0.1.0 (abc1234)"},
		{name: "date only", version: "v0.1.0", date: "2026-11-27T09:30:00Z", want: "v0.1.0 (2026-11-27T09:30:00Z)"},
		{name: "whitespace is trimmed", version: " v0.1.0 ", commit: " abc1234 ", date: " 2026-11-27 ", want: "v0.1.0 (abc1234, 2026-11-27)"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			Version, Commit, Date = test.version, test.commit, test.date
			if got := Format(); got != test.want {
				t.Errorf("Format() = %q, want %q", got, test.want)
			}
		})
	}
}
