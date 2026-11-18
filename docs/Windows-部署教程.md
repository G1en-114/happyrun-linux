> ⚠️ **历史文档（Windows 便携包）**：本文写的是原 Windows 版流程（UAC/.bat/.ps1），
> 目录结构也已调整（部分开发用文件夹未随公开仓库发布）。Linux 用户请看根目录 `README.md`
> 和 `docs/使用教程.md`。原 Windows 脚本仍保留在仓库里，可直接使用。

# HappyRun 便携包 — 新电脑部署教程

> 本教程面向「在一台全新的 Windows 电脑上从零跑起来」的场景。
> 文件夹自带 README.md 有更完整的功能说明，本教程只管部署。

---

## 一、包里有什么（拷贝清单）

```
HappyRun-portable\（放在任何目录都行：桌面 / D 盘 / U 盘，脚本全是相对路径）
├── README.md                      ← 原有说明文档
├── 部署教程-新电脑.md              ← 本文件
├── backup-原版-20261012\           ← 改造前的原版备份（可整体删除）
└── happyrun\                      ← 主目录（整个拷走）
    ├── start.ps1                  ← ★ 主入口：一键探活+抓包+正式跑
    ├── run-formal.ps1             ← 正式跑启动器（被 start.ps1 调用）
    ├── probe.mjs                  ← token 探活脚本
    ├── auto-run.mjs               ← 核心主程序（一般不直接跑）
    ├── roadnet.json               ← 校园路网（换学校必须重画）
    ├── config.template.json       ← 配置模板（凭证已抹除）
    ├── config.json                ← 实际配置（抓包自动生成，含真实 uid/token）
    ├── formal-run.log / .err.log  ← 运行日志（可删）
    ├── lib\                       ← 7 个 Node 模块（必须，程序逻辑都在这）
    └── capture\                   ← 抓包插件目录
        ├── happyrun-capture.py    ← mitmproxy 插件（抓登录态写回 config.json）
        ├── start-tun-capture.ps1  ← ★ 抓包入口（local 透明代理模式）
        ├── start-capture.ps1      ← 普通代理模式抓包（备用）
        ├── logs\                  ← 抓包日志（可删）
        └── __pycache__\           ← Python 缓存（可删）
```

**拷贝方式**：整个 `HappyRun-portable` 文件夹用 U 盘 / 网盘 / `robocopy` 拷到新电脑即可。
**路径随意**——脚本用相对路径定位，放 `D:\`、`C:\Tools\` 都行，但路径里**别带中文和空格**最稳妥。

`config.json` 里有你的真实 uid/token（还有当前学校的 school_id 等）：
- **想省事** → 直接连同 config.json 一起拷，token 没过期就能直接跑；
- **不想带凭证** → 删掉 config.json，到新电脑重新走一遍抓包（见第四节第 3 步）。

`formal-run.log`、`__pycache__`、`capture\logs` 是产物，删不删无所谓。

---

## 二、新电脑要装的环境（4 样）

| # | 依赖 | 版本要求 | 安装命令 / 来源 |
|---|------|---------|----------------|
| 1 | Node.js | ≥ 18（推荐 20/22 LTS） | `winget install OpenJS.NodeJS.LTS` 或 nodejs.org 下载安装包 |
| 2 | Python | 3.10+ | `winget install Python.Python.3.12` 或 python.org（**勾选 Add to PATH**） |
| 3 | mitmproxy | 12.x | `pip install mitmproxy` |
| 4 | 微信（电脑版） | 任意较新版本 | 官网下载，抓包时要在里面登录乐跑小程序 |

装完开个新 PowerShell 窗口验证：

```powershell
node -v      # 应显示 v18 以上
python -V    # 应显示 3.10 以上
pip install mitmproxy
mitmweb --version   # 应显示 12.x
```

> `pip install mitmproxy` 会自动带上 cryptography 等依赖，无需单独装。
> 如果 pip 提示"不是内部或外部命令"，说明 Python 没进 PATH，重装 Python 时勾选 Add to PATH。

另外确认两点：
- **能访问学校服务器** `tyxyzhpt.tyut.edu.cn`（校园网或 VPN 环境下）。
- **有管理员权限**——抓包用的 mitmproxy `--mode local` 需要 UAC 提权。

---

## 三、快速开始（3 步）

```powershell
# 1. 准备配置（如果拷贝时没带 config.json 就复制模板占位；带了可跳过）
Copy-Item happyrun\config.template.json happyrun\config.json

# 2. 抓包拿登录态：弹出 UAC 点「是」，然后在【电脑微信】里打开乐跑小程序登录
#    看到 "[login] 已写回 config.json" 即成功，回抓包窗口按 Ctrl+C 结束
powershell -ExecutionPolicy Bypass -File happyrun\capture\start-tun-capture.ps1

# 3. 一键正式跑（默认 3km 智能配速 3'30"~3'50"/km；token 失效会自动重抓）
powershell -ExecutionPolicy Bypass -File happyrun\start.ps1
```

> 建议第一次先做只读校验，不上传不等待：
> `powershell -ExecutionPolicy Bypass -File happyrun\start.ps1 -DryRun`
>
> 开跑后实时看进度（跑完自动报结果）：
> `powershell -ExecutionPolicy Bypass -File happyrun\watch.ps1`
> 跑完后看结果和有效次数台账：
> `powershell -ExecutionPolicy Bypass -File happyrun\result.ps1`

---

## 四、分步详解（第一次部署按这个来）

### 1. 拷贝文件夹
整个 `HappyRun-portable` 拷到新电脑任意目录（桌面、D 盘都行），在本文件夹内打开 PowerShell 执行以下命令。

### 2. 装环境
按上面第二节装 Node.js、Python、mitmproxy、电脑版微信，并验证版本。

### 3. 生成 / 迁移 config.json
- 拷贝时带了旧的 `config.json` → 直接用（token 失效也没关系，第 4 步会自动重抓）。
- 没带 → `Copy-Item happyrun\config.template.json happyrun\config.json`，
  然后靠抓包把真实凭证写进去（抓包插件会自动覆盖生成完整 config.json）。

### 4. 抓包拿登录态
```powershell
powershell -ExecutionPolicy Bypass -File <你的路径>\happyrun\capture\start-tun-capture.ps1
```
流程：
1. 脚本会装 mitmproxy CA 根证书到系统（local 模式需要），弹 UAC 点「是」；
2. 保持抓包窗口开着，打开【电脑版微信】，进入乐跑小程序完成登录；
3. 抓包窗口出现 `[login] 已写回 config.json` 即成功；
4. 在抓包窗口按 `Ctrl+C` 退出（可能再弹一次 UAC，点「是」）。

不想装可视化界面可以加 `-NoWeb` 用 mitmdump 无界面模式；`-WebPort` 可改 mitmweb 端口（默认 8081）。

### 5. 首次只读校验（DryRun）
```powershell
powershell -ExecutionPolicy Bypass -File happyrun\start.ps1 -DryRun
```
看到打卡点 3/3 覆盖即路网和配置正常。若报「无法纳入路网路径」，
是打卡点随机抽取组合问题，**重跑一次即可**。

### 6. 正式跑
```powershell
# 默认 4km / 1320 秒
powershell -ExecutionPolicy Bypass -File happyrun\start.ps1

# 自定义（4km 是计分线，别低于 4）
powershell -ExecutionPolicy Bypass -File happyrun\start.ps1 -Dist 4.2 -Time 1380

# 另开窗口看实时进度
Get-Content happyrun\formal-run.log -Wait -Encoding UTF8
```

### 7. 验收
日志末尾出现 `上传成功`，返回里 `record_failed_reason` 为空、`record_status: 1`（≥4km 计分）。
`record_status: 0` = 入库但不计分（不足 4km）。

---

## 五、踩坑备忘（新机器最容易中的几条）

1. **Node 必须带 `--use-system-ca`**：学校服务器证书链不在 Node 内置 CA 包里。
   start.ps1 / probe.mjs 已内置该参数，**手动裸跑 node 时一定要自己加**，否则必报 TLS 错。
2. **火绒等杀软会杀 mitmweb**：把 pip 的 site-packages 目录加入信任区，
   或杀软弹窗时点放行。
3. **Windows PowerShell 5.1 不支持 `&&`**：包内脚本已适配，自己写命令时用 `;` 代替。
4. **token 寿命实测 ≥25 分钟**：跑全程 22 分钟没问题；过期了 start.ps1 会自动拉起抓包重取，
   记得在电脑微信里重新登录一次。
5. **抓包模式下其它程序走代理的干扰**：local 模式只重定向目标域名流量，正常上网不受影响；
   但抓包期间别用微信传别的敏感内容的好习惯还是有的（CA 已装系统根证书）。
6. **必须是电脑版微信登录**：手机微信登录抓不到（流量不走这台电脑）。

---

## 六、换学校需要重做的事（同一台机器换校也适用）

1. 在 `capture\happyrun-capture.py` 的 `BASE_HOSTS` 加上新学校域名，重新抓包拿 school_id/course_id 等；
2. 对照卫星图重画 `roadnet.json`：`nodes`（经纬度）/ `edges`（节点对）/ `venaPoints`（打卡点）；
3. 改 `config.template.json` 里的 `run.centerLat / centerLon` 为新校区中心坐标。

---

## 七、本包相对上游的补丁（了解即可）

上游仓库：github.com/Suzuran28/Fuck-You-HappyRun。本包在其基础上：
1. 修复 `auto-run.mjs` 的 `--dryRun` 布尔解析 bug（原版裸 flag 会误入真实提交路径！）；
2. 等待结束、提交前自动重读 config.json 换新 token（长等待保命）；
3. 新增 run-formal.ps1 / start.ps1 / probe.mjs 一键化与 token 探活；
4. 两个抓包 ps1 已加 UTF-8 BOM，兼容 Windows PowerShell 5.1。
