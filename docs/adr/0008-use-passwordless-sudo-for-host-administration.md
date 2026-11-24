# 使用免密 sudo 执行主机管理操作

goDesk 作为供一位受信任操作者使用的主机管理员入口，默认以普通账号运行，通过主机现有的免密 sudo 授权，或由部署者显式安装一条授予完整管理权限的 GoDesk 托管规则。文件管理器显式进入管理员模式后，通过 sudo 短时调用同一二进制来复用现有文件语义；systemd 写操作也可经 sudo 执行。sudo 负责授权，部署仍只需一个二进制和按需启用的主机配置。

此决策更新了 [ADR 0002](0002-use-host-account-file-permissions.md) 的文件权限范围，以及 [ADR 0007](0007-detect-service-backend-at-startup.md) 的服务权限部分。命令、文件操作与部署约定见[主机权限契约](../privileges.md)。
