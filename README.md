# HappyRun · Linux 便携版

把「乐跑」跑步记录工具做成 **Linux 上开箱即跑** 的版本：核心是零 npm 依赖的 Node.js 脚本，
原包只支持 Windows 的 `.ps1` / `.bat` 启动器，这里换成了 `bash` + `node` 的跨平台实现，
并补上了 Linux 下真正需要的登录抓包流程（mitmproxy 代理 / nftables 透明模式 + CA 自动安装）。

> 上游项目：[Suzuran28/Fuck-You-HappyRun](https://github.com/Suzuran28/Fuck-You-HappyRun)（MIT）
> 本仓库 = 便携包整理 + Linux 适配 + 文档。**仅供技术交流，使用风险自负**（见文末）。

---

## 一、这是什么

一个本地运行的「跑步记录生成器」：连学校乐跑服务端拉取本次随机打卡点 → 在校园路网上 A* 规划路线 →
用样条 + GPS 噪声引擎生成一条像真人跑出来的轨迹 → 真实等待目标时长后加密上传。
不做定位伪造以外的事，也不改服务端。

**默认策略**：3km 智能配速（平均 3'30"~3'50"/km，距离带 3.0~3.1km，随机 3 个打卡点全走到）。

### 特性

| 能力 | 说明 |
|---|---|
| 智能配速 | 路线规划完成后才定距离/用时，配速自动落在设定带内，每次略有浮动 |
| 路线规划 | `roadnet.json` 校园路网（497 节点 / 521 边 / 15 打卡点）+ A*，打卡点 30m 内必经过 |
| 轨迹平滑 | Catmull-Rom 样条 + 三分量 GPS 噪声（慢漂移 / 中频摆动 / 微噪声），转向 <3% 急转 |
| 安全校验 | 非有效时段直接拦截；任一打卡点无法纳入路线则中止、不上传 |
| 实时进度 | 终端进度条 + 本地浏览器实时轨迹图（`127.0.0.1:8947`） |
| 台账 | 每次结果按账号写入 `run-history-<学号>.jsonl`，有效次数一目了然 |
| 零依赖 | 不需要 `npm install`，Node ≥ 18 即可；只有抓包才需要 Python + mitmproxy |

---

## 二、环境

| 用途 | 依赖 | 安装 |
|---|---|---|
| 跑步（必须） | Node.js ≥ 18（实测 v26） | Arch: `sudo pacman -S nodejs` / 或用 nvm |
| 抓包（必须，登录/换号时） | Python 3.10+、mitmproxy 12.x | Arch: `sudo pacman -S mitmproxy`；通用: `pipx install mitmproxy` |
| 透明抓包（可选） | nftables + sudo | Arch 自带 `nft` |

Node 用 `--use-system-ca` 启动：学校服务器的证书链不在 Node 内置 CA 里，缺了会报 TLS 错误。
启动脚本会自动检测支持情况。

---

## 三、快速开始（3 步）

```bash
# 0) 进到本目录
cd HappyRun-portable

# 1) 准备配置文件（抓包会自动生成；也可以先复制模板填）
cp happyrun/config.template.json happyrun/config.json

# 2) 登录抓包：在客户端里登录一次乐跑，登录态写进 config.json
./capture.sh --transparent --once     # 推荐：nftables 透明模式（需要 sudo）
#    或者不认代理设置的客户端用普通代理模式：
#    ./capture.sh --once

# 3) 一键正式跑（默认 3km 智能配速，约 11~12 分钟真实等待）
./start.sh
```

跑的过程中另开一个终端看实时进度：

```bash
./watch.sh
```

跑完看台账：

```bash
./result.sh
```

> **第一次用建议先彩排**：`./dryrun.sh` 只拉真实打卡点、规划路线、校验 3/3 覆盖，
> 不上传也不等待，几十秒结束。

---

## 四、脚本一览

| 命令 | 作用 | 什么时候用 |
|---|---|---|
| `./capture.sh --transparent --once` | 透明抓包，抓到登录态自动退出 | 首次 / token 过期 / 换账号 |
| `./capture.sh --once` | 普通代理抓包（127.0.0.1:8080） | 客户端能手动设代理时 |
| `./install-ca.sh` | 安装 mitmproxy CA 到系统信任库 | 抓包时客户端报 TLS 错 |
| `./start.sh` | **主入口**：探活 → 失效自动抓包等待 → 正式跑 | 每次跑步 |
| `./dryrun.sh` | 只读校验（不上传、不等待） | 换环境 / 不放心时 |
| `./watch.sh` | 实时进度 / 配速 / ETA，跑完自动出结果 | 跑步进行时 |
| `./result.sh` | 上次运行日志 + 当前账号有效次数台账 | 跑完之后 |
| `./result.sh --all` | 列出所有账号的台账 | 多账号 |
| `./result.sh --account=<学号>` | 看指定账号 | 换账号后 |

常用参数：

```bash
./start.sh --time=700          # 固定用时 700 秒（退回固定用时模式）
./start.sh --dist=4.2          # 锁定距离 4.2km
./start.sh --dry               # 等同 ./dryrun.sh
./watch.sh --once              # 只显示一帧（脚本化/排错用）
./watch.sh --no-live           # 不启动实时轨迹图服务
```

日志与产物（都在 `happyrun/` 下，**不入库**）：

`formal-run.log`（当次日志）· `formal-run.status.json`（实时状态）·
`formal-run.track.json`（轨迹）· `run-history-<学号>.jsonl`（台账）· `record-preview.json`（离线预览）

---

## 五、抓包的两种模式（Linux 重点）

Linux 没有 Windows 的 `--mode local`，这里提供两条路：

### 5.1 透明模式（推荐）

```bash
./capture.sh --transparent --once
```

- 自动把 `config.json` 里 `baseUrl` 的域名解析成 IP，用 **nftables 只在 OUTPUT 链重定向这些 IP 的 80/443** 到本地 mitmproxy；
- 同时 `reject` 这些 IP 的 UDP 443（QUIC），避免客户端绕过 TCP 代理；
- 只影响目标学校域名，其余流量（含你自己的 SSH/网页）不受影响；
- 退出（Ctrl+C 或 `--once` 抓完）自动清理规则；异常残留时：
  ```bash
  sudo nft delete table ip happyrun_cap
  sudo nft delete table ip happyrun_cap6
  ```
- `--dump` 可以先看规则不执行。

> 透明模式需要 root 才能改防火墙，脚本会 `sudo` 提权。
> 客户端（微信小程序 / Android 模拟器 / 浏览器）必须在**同一个用户**下运行（root 自己的流量会被跳过，避免代理环路）。

### 5.2 普通代理模式

```bash
./capture.sh --once
# 另开终端/或先导出：
export http_proxy=http://127.0.0.1:8080 https_proxy=http://127.0.0.1:8080
```

适合能配置代理的客户端（curl、浏览器、模拟器网络设置、`mitmweb` 可视化）。

### 5.3 证书

抓包客户端必须信任 mitmproxy 的 CA：

```bash
./install-ca.sh            # Arch 用 trust anchor；Debian 用 update-ca-certificates；Fedora 用 update-ca-trust
./install-ca.sh --remove   # 想撤销时
```

脚本会自动尝试导入 Chrome/Electron 用的 NSS 数据库（需要 `certutil`）。

---

## 六、目录结构

```
HappyRun-portable/
├── start.sh / dryrun.sh / watch.sh / result.sh     ← Linux 入口
├── capture.sh / install-ca.sh                      ← 抓包入口
├── happyrun/
│   ├── auto-run.mjs           核心：拉打卡点 → 规划 → 生成轨迹 → 等待 → 上传
│   ├── probe.mjs              token 探活
│   ├── config.template.json   配置模板（凭证已抹除）
│   ├── config.json            真实凭证（抓包生成，.gitignore 已排除）
│   ├── roadnet.json           校园路网（换学校必须重画）
│   ├── lib/                   9 个 Node 模块（签名/加密/OSS/轨迹/路线/配速…）
│   ├── linux/                 Linux 适配层：start.sh / run-formal.sh / watch.mjs / result.mjs
│   ├── capture/               mitmproxy 插件 + Linux 抓包脚本 + CA 安装
│   └── tools/                 离线工具：实时轨迹图 / 路网编辑器 / 渲染 PNG / 校验
└── docs/                      详细教程
```

---

## 七、Linux 适配改了什么

| 原 Windows 实现 | Linux 版 | 说明 |
|---|---|---|
| `start.ps1`（探活 + UAC 抓包 + 正式跑） | `happyrun/linux/start.sh` | 失效时自动开一个终端跑抓包并轮询探活，等价流程 |
| `run-formal.ps1`（tee 日志） | `happyrun/linux/run-formal.sh` | `tee` 写 `formal-run.log` |
| `watch.ps1`（PowerShell 进度条） | `happyrun/linux/watch.mjs` | 纯 Node，ANSI 进度条 + 日志增量尾部 + `o` 键开轨迹图 |
| `result.ps1`（台账） | `happyrun/linux/result.mjs` | 同样按账号读 `run-history-*.jsonl` |
| `--mode local`（Windows 透明重定向） | nftables + `--mode transparent` | 按解析出的学校 IP 精确重定向 |
| `Import-Certificate` 装 CA | `install-ca.sh` | trust / update-ca-certificates / update-ca-trust 自动判断 |
| `.bat` 双击 | `.sh` 执行 | 保留原 `.bat` / `.ps1`，Windows 下照旧可用 |

Windows 原脚本（`*.bat`、`happyrun/*.ps1`）**原样保留**，没有删改逻辑；Linux 只是新增了一层。

---

## 八、常见问题

**TLS / 证书错误**
Node 必须带系统 CA：脚本已自动加 `--use-system-ca`；低版本 Node 请升级到 ≥ 18。
抓包时客户端报证书错误 → `./install-ca.sh` 后重启客户端。

**「打卡点无法纳入路网路径」**
每次随机抽 3 个打卡点，偶发抽到路网覆盖不到的点。直接重跑 `./start.sh` 换一组即可。

**「不在有效跑步时段」**
脚本会按服务端规则（默认 6:00–22:30）拦截，避免上传被判无效。时段内再跑。

**token 多久过期？**
实测 ≥ 25 分钟；默认 3km 档真实等待约 11~12 分钟，一次跑完通常没问题。
`--time` ≥ 900 秒的长跑建议中途再抓一次：新 token 会在提交前被自动读取。

**mitmproxy 装不上 / Python 3.14**
`pip install mitmproxy` 对很新的 Python 可能没有轮子，建议 `pipx install mitmproxy` 或用系统包
（Arch: `pacman -S mitmproxy`）。脚本会检查并给出提示。

**路径带中文/空格？**
bash 脚本本身没问题，但最稳的还是放纯英文路径。

**想换账号**
上一个账号跑完 → `./capture.sh --once` 用新账号登录 → 直接 `./start.sh`。
旧进程会被自动顶掉，台账按账号分文件，各自从第 1 次计数。

---

## 九、隐私与安全（重要）

- `happyrun/config.json` 含 **uid / token / 学号**，`.gitignore` 已排除，**不要提交**。
- `happyrun/capture/logs/*.jsonl` 记录的是**解密后的明文请求/响应**，同样含 token，已被忽略。
- 运行日志/台账含学号与跑步记录，也已忽略。
- 公开仓库里只有模板（`config.template.json`）和路网数据，不含任何真实凭证。
- 推送前建议自查一遍：`git diff --cached | grep -iE 'token|uid|20[0-9]{8}'`。

---

## 十、许可与免责

代码沿用上游 MIT 许可（见 `LICENSE`、`NOTICE`）。

本项目仅用于**协议分析与自动化技术交流**。使用它伪造跑步记录可能违反学校规定、导致成绩作废或账号封禁，
相关后果由使用者自行承担；请优先考虑正常完成锻炼。
