package terminal

import (
	"fmt"
	"io"
	"slices"
	"strings"
	"sync/atomic"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

type display struct {
	*vt.Emulator
	normalScreen screen
	modes        map[ansi.Mode]bool
	noScrollback bool
	replyEnabled atomic.Bool
}

type snapshot struct {
	Type       string `json:"type"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	Output     string `json:"output"`
	Controller bool   `json:"controller"`
}

type screen struct {
	text   string
	cursor uv.Position
}

func newDisplay(lines int, reply func([]byte)) *display {
	d := &display{
		Emulator: vt.NewEmulator(initialCols, initialRows),
		modes:    make(map[ansi.Mode]bool), noScrollback: lines == 0,
	}
	d.SetScrollbackSize(max(1, lines))
	d.SetCallbacks(vt.Callbacks{
		EnableMode:  func(mode ansi.Mode) { d.modes[mode] = true },
		DisableMode: func(mode ansi.Mode) { d.modes[mode] = false },
	})
	d.RegisterCsiHandler(ansi.Command('?', 0, 'h'), func(params ansi.Params) bool {
		if !d.IsAltScreen() {
			params.ForEach(0, func(_, mode int, _ bool) {
				if mode == 1047 || mode == 1049 {
					d.normalScreen = d.currentScreen()
				}
			})
		}
		return false // Let the emulator process the mode change.
	})
	d.RegisterEscHandler('c', func() bool {
		clear(d.modes)
		d.normalScreen = screen{}
		return false
	})
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := d.Read(buf)
			if n > 0 && d.replyEnabled.Load() {
				reply(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	return d
}

func (d *display) close() {
	// The emulator exposes its reply pipe as a writer. Closing the pipe
	// releases the reader without mutating emulator state on that goroutine.
	_ = d.InputPipe().(io.Closer).Close()
}

func (d *display) write(data []byte, detached bool) {
	d.replyEnabled.Store(detached)
	_, _ = d.Write(data)
	if d.noScrollback {
		d.ClearScrollback()
	}
}

func (d *display) currentScreen() screen {
	return screen{text: d.Render(), cursor: d.CursorPosition()}
}

func (s screen) render(output *strings.Builder, cols, rows int) {
	lines := strings.Split(s.text, "\n")
	for y := range rows {
		if y > 0 {
			output.WriteString("\r\n")
		}
		if y < len(lines) {
			output.WriteString(ansi.Truncate(lines[y], cols, ""))
		}
	}
	fmt.Fprintf(output, "\x1b[%d;%dH", min(s.cursor.Y+1, rows), min(s.cursor.X+1, cols))
}

func (d *display) resize(cols, rows int) {
	// Keep lines above the cursor in scrollback when a smaller viewport
	// moves the top of the normal screen down.
	if shift := d.CursorPosition().Y - rows + 1; shift > 0 && !d.IsAltScreen() {
		width := d.Width()
		if !d.noScrollback {
			line := make(uv.Line, width)
			for y := range shift {
				for x := range width {
					line[x] = *d.CellAt(x, y)
				}
				d.Scrollback().Push(line)
			}
		}
		for y := range rows {
			for x := 0; x < width; {
				cell := *d.CellAt(x, y+shift)
				d.SetCell(x, y, &cell)
				x += max(1, cell.Width)
			}
		}
	}
	d.Emulator.Resize(cols, rows)
}

func (d *display) snapshot() snapshot {
	var output strings.Builder
	cols, rows := d.Width(), d.Height()
	for _, line := range d.Scrollback().Lines() {
		// Let the browser wrap retained rows from wider terminal sizes.
		output.WriteString(line.Render())
		output.WriteString("\r\n")
	}
	output.WriteString("\x1b[m")
	if d.IsAltScreen() {
		// Scroll the normal buffer into place before drawing the alternate
		// screen. Leaving it in xterm then restores the Shell's normal buffer.
		d.normalScreen.render(&output, cols, rows)
		output.WriteString("\x1b[?1049h")
	}
	d.currentScreen().render(&output, cols, rows)

	// Position the cursor before restoring modes that affect input or wrapping.
	modes := make([]int, 0, len(d.modes))
	for mode := range d.modes {
		if dec, ok := mode.(ansi.DECMode); ok && dec != 1047 && dec != 1048 && dec != 1049 {
			modes = append(modes, int(dec))
		}
	}
	slices.Sort(modes)
	for _, value := range modes {
		mode := ansi.DECMode(value)
		if d.modes[mode] {
			output.WriteString(ansi.SetMode(mode))
		} else {
			output.WriteString(ansi.ResetMode(mode))
		}
	}
	return snapshot{Type: "snapshot", Cols: cols, Rows: rows, Output: output.String()}
}
