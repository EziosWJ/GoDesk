# 使用 SQLite 保存 goDesk 的持久化数据

goDesk 通过 Go 标准库 `database/sql` 和 `modernc.org/sqlite` 在本机保存操作者密码哈希、JWT 签名密钥和应用配置。数据库文件位于运行数据目录，表结构通过版本化 SQL 演进。SQLite 随应用进程运行，驱动无需 CGO，便于保持单二进制交付。
