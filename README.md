<div align="center">
  <img src="frontend/public/favicon.svg" width="96" height="96" alt="goDesk logo">
  <h1>goDesk</h1>
  <p><strong>Your Linux host, in a browser.</strong></p>
  <p>A self-hosted web desktop for managing a single Linux host.</p>
  <p>
    <a href="https://github.com/EziosWJ/GoDesk/releases"><img src="https://img.shields.io/github/v/release/EziosWJ/GoDesk?label=release" alt="Latest release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache License 2.0"></a>
    <a href="https://github.com/EziosWJ/GoDesk/releases"><img src="https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black" alt="Linux"></a>
  </p>
  <p>English · <a href="README.zh-CN.md">简体中文</a></p>
</div>

![goDesk desktop and file manager](frontend/docs/screenshots/desktop-light-2026.png)

goDesk brings files, a terminal, system monitoring, and service management into a desktop in your browser. It is designed for one operator managing one Linux host. The Go server embeds the frontend, so a release runs as a single binary.

## Features

- **Desktop workspace** — Open multiple windows, search apps, customize the appearance, and arrange windows with snapping and split views.
- **Files and editing** — Browse, upload, download, move, and edit host files in a graphical interface.
- **Terminal sessions** — Run shell sessions in the browser and reconnect to them after closing a window or browser.
- **System monitoring** — Inspect CPU, memory, storage, network, and ports, with a host health overview in the taskbar.
- **Service management** — View and manage systemd services and their logs on supported hosts.
- **Extensions** — Install and enable extensions through the desktop, with configurable service permissions.

| Start menu | System monitoring |
| --- | --- |
| ![Dark desktop with the start menu](frontend/docs/screenshots/start-menu-dark-2026.png) | ![System settings and monitoring windows](frontend/docs/screenshots/system-monitor-dark-2026.png) |

![Host health panel](frontend/docs/screenshots/health-panel-dark-2026.png)

## Get started

1. Download the archive for your Linux architecture (`386`, `amd64`, `arm64`, or `armv7`) from [Releases](https://github.com/EziosWJ/GoDesk/releases). A `SHA256SUMS` file is available alongside the archives.
2. Extract the archive and start the binary (the example below uses `amd64`):

   ```sh
   tar -xzf godesk_*_linux_amd64.tar.gz
   ./godesk -listen 127.0.0.1:5000 -data-dir ./data
   ```

3. Open [http://localhost:5000](http://localhost:5000) and create an operator password. goDesk creates its SQLite database in the data directory.

The example listens on localhost. The default listen address is `0.0.0.0:5000`; use `-listen` to choose the address appropriate for your environment. See the [host privileges documentation](docs/privileges.md) for access and permission details.

### Host permissions

Run goDesk as your usual Linux user. File management and service operations depend on host permissions. For passwordless administrator access, configure the optional sudo rule on the host:

```sh
sudo ./godesk --setup-sudo
./godesk --check-sudo
```

This allows **any process running as that Linux user** to execute root commands without a password. When passwordless sudo is enabled or goDesk runs as root, treat it as an administrator entry point and complete initial setup in a trusted environment. See [host privileges](docs/privileges.md) for the permission scope and removal instructions.

## Build and develop

Development and full builds require Linux, Go 1.26, Node.js 24, pnpm 12, and GNU Make.

```sh
git clone https://github.com/EziosWJ/GoDesk.git
cd GoDesk
pnpm --dir frontend install --frozen-lockfile
make dev
```

Open the Vite URL, normally `http://localhost:5173`. The development server proxies API requests to the Go backend on port 5000. To build a single binary and run checks:

```sh
make build
pnpm --dir frontend lint
go -C backend test ./...
```

For Extension Host source development, see the [extension documentation](docs/extensions.md#从源码联调-godesk).

## Documentation

Most detailed documentation is currently in Chinese.

- [Frontend development](frontend/README.md) · [UI design](frontend/docs/ui-design/01-design-principles.md)
- [Authentication](docs/authentication.md) · [Host privileges](docs/privileges.md)
- [File management and text editing](docs/file-management.md) · [Terminal sessions](docs/terminal.md)
- [System monitoring and host health](docs/system-monitoring.md) · [Service management](docs/services.md)
- [Extensions and Host API](docs/extensions.md) · [Architecture decisions](docs/adr/)

## Contributing

Issues and suggestions are welcome through [GitHub Issues](https://github.com/EziosWJ/GoDesk/issues). To work on a change, follow the development instructions above and run the relevant checks.

## Acknowledgments

Thanks to the authors and contributors of the open source projects that make goDesk possible, including [React Web Desktop](https://github.com/EziosWJ/react-web-desktop), [React](https://react.dev/), [WMKit](https://github.com/Surdeddd/wmkit), [xterm.js](https://xtermjs.org/), [Monaco Editor](https://microsoft.github.io/monaco-editor/), [Extension Host](https://github.com/EziosWJ/Extension-Host), [SQLite](https://sqlite.org/), and [gopsutil](https://github.com/shirou/gopsutil), as well as all other direct and indirect dependencies.

## License

[Apache License 2.0](LICENSE).
