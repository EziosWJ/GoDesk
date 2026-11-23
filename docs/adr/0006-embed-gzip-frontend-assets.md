# 构建时压缩并嵌入前端资源

为缩小 [goDesk 单二进制发布包](0001-ship-frontend-in-go-binary.md)，生产构建对每个前端文件比较 gzip 和原始版本的大小，只嵌入较小的版本。服务根据 `Accept-Encoding` 提供预压缩内容，或用 Go 标准库按需解压，并通过 `Vary: Accept-Encoding` 区分缓存中的响应。

使用当前前端产物实测，嵌入资源从 5.72 MiB 降至 1.54 MiB，Linux amd64 发布包从 15.68 MiB 降至 11.52 MiB，缩小 26.5%。
