# 012 发行版与更新

Warren 以 GitHub Release 的形式发布：单文件的 `warren`（CLI、守护进程和界面都在里面），以及可选的桌面应用。已经装好的 Warren 可以自己检查和安装新版本。前置阅读：[003 运行时](003-runtime.md)、[005 安全边界](005-security.md)、[006 界面与常驻](006-interface.md)。

## 一个版本号

版本号只有一个来源：根目录 `package.json` 的 `version`。

- 守护进程通过 `apps/daemon/src/version.ts` 读取它，编译时一起打进二进制。`warren --version`、`GET /health` 和设置页"关于"显示的都是它。
- 桌面应用的 `tauri.conf.json` 和 `Cargo.toml` 也写着版本号。`bun scripts/version.ts X.Y.Z` 一次改三处。
- 发布脚本会检查三处是否一致、tag 是否等于 `vX.Y.Z`，不一致就拒绝构建。

## 一个发行版里有什么

`scripts/release.ts` 把这些文件写进 `dist/release/`：

| 文件 | 内容 |
|---|---|
| `warren-darwin-arm64.tar.gz`、`warren-darwin-x64.tar.gz` | 用 `bun build --compile --target=bun-darwin-<arch>` 交叉编译的单文件程序 |
| `Warren-darwin-arm64.app.zip` | 桌面应用（CI 在 Apple Silicon 上构建，所以目前只有 arm64） |
| `release.json` | 清单：版本号，以及每个文件的名称、种类（`cli`/`desktop`）、架构、大小和 SHA-256 |
| `release.json.sig` | 清单的 Ed25519 签名（base64） |
| `SHA256SUMS` | 给 `shasum -a 256 -c` 用的校验和 |

## 信任模型

只校验哈希是不够的：能替换文件的人，同样能替换写着哈希的那个文件。所以更新以**签名**为准。

- 发布密钥是一对 Ed25519 密钥。公钥写死在源码里（`RELEASE_PUBLIC_KEY`，`apps/daemon/src/runtime/updates.ts`），随二进制一起编译。
- 私钥只存在两个地方：维护者本机（`~/.warren-release/signing-key`，权限 0600，不在仓库里），以及仓库的 Actions secret `WARREN_RELEASE_SIGNING_KEY`。
- 安装一个更新必须同时满足：
  1. `release.json.sig` 能用编译进来的公钥验证 `release.json` 的原始字节；
  2. 下载到的文件的大小和 SHA-256 等于签名清单里写的值。
- 任何一步不满足，都不安装，原文件保持不动。所以即使 Release 页面被篡改，或者下载过程被中间人替换，也做不出一个能被已安装的 Warren 接受的更新。

签名用 Web Crypto 的 Ed25519，不引入额外依赖。`bun scripts/release-key.ts` 生成密钥对：它把私钥写到 `~/.warren-release/signing-key`，打印公钥，并且拒绝覆盖已有的密钥。

**换密钥的代价：** 已经安装的版本只认旧公钥。换了密钥之后，它们无法自动更新到新密钥签名的版本，只能用 `install.sh` 重新安装一次。所以私钥要备份好，不要轻易更换。

## 发布流程

```sh
bun scripts/version.ts 0.2.0     # 改 package.json、tauri.conf.json、Cargo.toml
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

推送 `v*` tag 会触发 `.github/workflows/release.yml`。它在 macOS 上依次：

1. 安装依赖，运行类型检查和 lint；
2. 构建桌面应用；
3. 运行 `bun scripts/release.ts --require-signature --desktop <Warren.app>`（没有签名密钥就失败，不会发布一个无法更新的版本）；
4. 把 `dist/release/*` 上传为 GitHub Release，说明由提交记录自动生成。

在本地构建同样的产物（不发布）：

```sh
WARREN_RELEASE_SIGNING_KEY="$(cat ~/.warren-release/signing-key)" bun scripts/release.ts --require-signature
```

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/Nguxw/Warren/main/install.sh | sh
```

`install.sh` 的步骤：

1. 判断 Mac 的架构，从 `releases/latest/download` 下载对应的压缩包和 `SHA256SUMS`；
2. 用 `shasum -a 256 -c` 校验，不匹配就不安装；
3. 安装到 `~/.local/bin/warren`（可以用 `WARREN_INSTALL_DIR` 改位置），并在这个目录不在 `PATH` 里时给出提示。

第一次安装只校验哈希，信任的是 HTTPS 和 GitHub。之后的每次更新都校验签名。

桌面应用可以从 Release 页面下载 `Warren-darwin-arm64.app.zip`，解压后拖进"应用程序"。应用目前没有经过 Apple 公证，所以浏览器下载的副本会被 Gatekeeper 拦下，需要执行一次：

```sh
xattr -dr com.apple.quarantine /Applications/Warren.app
```

或者在访达里右键 →"打开"。由 `warren update` 下载的更新不带隔离属性，所以不会被拦。

## 更新

### 命令行

```sh
warren update --check    # 只查看有没有新版本
warren update            # 下载、校验并安装
```

`warren update` 的步骤：

1. 替换正在运行的二进制（`process.execPath`）。新文件先解压到同一目录下的 `.warren.update`，设为可执行，再 `rename` 覆盖旧文件，所以这个路径上不会出现写了一半的程序；
2. 如果 `/Applications` 或 `~/Applications` 里有 Warren.app，用同样的方式整体换掉；
3. 如果装了 launchd 服务，用 `launchctl kickstart -k` 重启守护进程，让它运行新版本。

### 守护进程和界面

`UpdateService`（`apps/daemon/src/runtime/update-service.ts`）的规则：

- **只有编译出来的二进制会自动检查，** 从源码运行的开发实例和测试不会发出任何请求。启动 1 分钟后查一次，之后每天一次。
- **可以关闭：** 设置页"关于"里的"自动检查更新"，对应 `config.json` 里的 `updates.check`，修改后立即生效。
- **请求里没有个人信息：** 只访问 GitHub 的公开 API，`User-Agent` 固定为 `warren-updater`。
- **有新版本时，** 侧栏的"设置"旁边出现一个小圆点，"关于"里显示版本号和"安装"按钮。
- **点击安装后，** 守护进程替换二进制和桌面应用。如果它运行在 launchd 下（`XPC_SERVICE_NAME` 以 `dev.warren` 开头），就给自己发 SIGTERM 正常退出，由 launchd（`KeepAlive`）用新版本拉起；界面轮询 `/health`，等守护进程回来后自动刷新。不在 launchd 下运行时，会提示你手动重启。
- **从源码运行时不安装，** `POST /update/install` 返回 409，界面提示用 `git pull` 更新。
- **还没有发布过任何版本时，** 检查的结果是"还没有发布过发行版"，这是正常状态，不算错误。

正在运行的任务不受影响。守护进程正常退出前，所有事件都已经落盘；重启后，任务按 [002](002-loop-and-recovery.md) 的规则从日志继续。对外动作不会因为重启而重复执行。

### API

| 路由 | 作用 |
|---|---|
| `GET /update` | 最近一次检查的结果：当前版本、最新版本、是否可以更新、这个进程能否自己安装 |
| `POST /update/check` | 立即检查一次 |
| `POST /update/install` | 安装最新版本；从源码运行时返回 409 |

## 测试

`apps/daemon/tests/updates.test.ts` 使用一个假的 `ReleaseSource` 和测试中临时生成的密钥对，覆盖以下情况：

- 版本比较，包括预发布版本；
- 签名正确的新版本会被安装；
- 签名之后被改过的清单，或者用另一把密钥签名的清单，会被拒绝；
- 和清单不符的文件不安装，原文件不变；
- 清单里没有这台机器的架构时报错；
- 守护进程的 `/health`、`/update`、`/update/check`，以及从源码运行时拒绝安装；
- 还没有发布过版本时，检查结果为"未发布"，不是错误。

真实的端到端验证：先在本地签名构建一个发行版，把一个指向 `dist/release` 的 `ReleaseSource` 交给 `Updater`，用编译进来的公钥完成校验，安装出来的二进制可以正常运行。
