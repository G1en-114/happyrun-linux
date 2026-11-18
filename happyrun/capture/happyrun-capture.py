#!/usr/bin/env python3
import os
import sys
import json
import base64
import binascii
import datetime
import logging
from pathlib import Path

from mitmproxy import http, ctx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

# addon 日志绕开 mitmproxy 的 termlog（后者会被 termlog_verbosity=warn 压掉，
# 导致 [login] 信息看不到）。直接挂一个 stderr handler，独立于 mitmproxy 事件日志。
log = logging.getLogger("happyrun")
if not log.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(_h)
log.setLevel(logging.INFO)
log.propagate = False  # 不向 mitmproxy 的 root logger 传播，避免被 termlog 过滤

# ───────── 协议常量（references/artifacts/signer.mjs 一致） ─────────
SALT = "rDJiNB9j7vD2"
AES_KEY = b"Wet2C8d34f62ndi3"
AES_IV = b"K6iv85jBD8jgf32D"

BASE_HOSTS = ("tyxyzhpt.tyut.edu.cn",)  # 可加多学校

# 写回 config.json 的路径（脚本位于 happyrun/capture/，config 在 happyrun/）
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
LOG_DIR = Path(__file__).resolve().parent / "logs"
STOP_FLAG = Path(__file__).resolve().parent / "STOP"  # one-click 写入此文件请求抓包退出
LOG_DIR.mkdir(exist_ok=True)


def aes_decrypt(b64: str) -> str:
    """AES-128-CBC / PKCS7 解密 base64 密文 → utf8"""
    try:
        raw = base64.b64decode(b64)
    except (binascii.Error, ValueError):
        raise ValueError("bad base64")
    cipher = Cipher(algorithms.AES(AES_KEY), modes.CBC(AES_IV))
    dec = cipher.decryptor()
    padded = dec.update(raw) + dec.finalize()
    unp = PKCS7(128).unpadder()
    plain = unp.update(padded) + unp.finalize()
    return plain.decode("utf-8")


def aes_encrypt(plain: str) -> str:
    """AES-128-CBC / PKCS7 加密 → base64（调试用）"""
    cipher = Cipher(algorithms.AES(AES_KEY), modes.CBC(AES_IV))
    enc = cipher.encryptor()
    padder = PKCS7(128).padder()
    padded = padder.update(plain.encode("utf-8")) + padder.finalize()
    raw = enc.update(padded) + enc.finalize()
    return base64.b64encode(raw).decode("ascii")


def safe_json(s: str):
    try:
        return json.loads(s)
    except Exception:
        return None


# 哪些接口的响应里含登录态字段，提取后可写回 config.json
# loginByCode/loginAuth: 含 uid + token_data.access_token
# UserInfo: 含 school_id/class_id/student_num/uid
# WpIndex/index: 含 school_id/uid/term_name (补全用)
# WpRun/getTermList: 含 term_id (补全用)
LOGIN_METHODS = (
    "WpLogin/loginByCode", "WpLogin/loginAuth", "WpLogin/UserInfo",
    "WpIndex/index", "WpRun/getTermList",
)

# 哪些字段属于登录态公共参数
COMMON_FIELDS = (
    "school_id", "term_id", "course_id", "class_id",
    "student_num", "card_id", "uid", "token",
)


class HappyrunCapture:
    def __init__(self):
        self.captured = {}
        self.log_fp = None
        self.count = 0
        self.write_config = True
        self.log_enabled = True
        self.quiet = False

    def tick(self):
        """每秒轮询：happyrun/capture/STOP 文件存在则优雅退出。
        用途：登录抓包完成后由 one-click 停止抓包，让跑步/上传流量直连，
        避免僵尸抓包把上传连接拖死（UND_ERR_CONNECT_TIMEOUT）。"""
        try:
            if STOP_FLAG.exists():
                STOP_FLAG.unlink(missing_ok=True)
                ctx.log.info('[happyrun] 收到停止指令，抓包退出')
                ctx.master.shutdown()
        except Exception:
            pass
    def load(self, loader):
        # 支持 mitmproxy 命令行/交互式设置
        loader.add_option(
            name="happyrun_write_config",
            typespec=bool,
            default=True,
            help="是否自动把抓到的登录态写回 config.json",
        )
        loader.add_option(
            name="happyrun_log",
            typespec=bool,
            default=True,
            help="是否把解密后的明文请求/响应写日志文件",
        )
        loader.add_option(
            name="happyrun_quiet",
            typespec=bool,
            default=False,
            help="安静模式：只打印 [login] 与抓取进度，不打印 [REQ]/[RESP] 明文摘要",
        )

    def configure(self, updated):
        # 缓存选项，避免在每个 hook 里访问 ctx.options
        try:
            self.write_config = ctx.options.happyrun_write_config
            self.log_enabled = ctx.options.happyrun_log
            self.quiet = ctx.options.happyrun_quiet
        except Exception:
            pass

    def _open_log(self):
        if self.log_fp is None:
            ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            self.log_fp = open(LOG_DIR / f"capture_{ts}.jsonl", "a", encoding="utf-8")
        return self.log_fp

    def request(self, flow: http.HTTPFlow):
        if flow.request.pretty_host not in BASE_HOSTS:
            return
        if not flow.request.path.startswith("/v3/api.php/"):
            return
        self.count += 1
        method_path = flow.request.path[len("/v3/api.php/"):]
        try:
            raw = flow.request.get_text() or ""
            decoded = None
            if raw:
                pairs = dict(
                    (k, v) for k, _, v in (item.partition("=") for item in raw.split("&"))
                )
                if "data" in pairs:
                    decoded = aes_decrypt(pairs["data"])
            entry = {
                "ts": datetime.datetime.now().isoformat(timespec="seconds"),
                "dir": "REQ",
                "method_path": method_path,
                "flag": flow.request.headers.get("flag", ""),
                "decoded": decoded,
            }
            if not self.quiet:
                log.info(f"[REQ] {method_path} flag={entry['flag']}")
                if decoded:
                    log.info(f"  body: {decoded[:200]}")
            if decoded:
                self.captured["last_request"] = decoded
            if self.log_enabled:
                fp = self._open_log()
                fp.write(json.dumps(entry, ensure_ascii=False) + "\n")
                fp.flush()
        except Exception as e:
            # 非 happyrun 业务请求（GET/其它 Content-Type）会 decode 失败，静默
            log.debug(f"request decode skipped: {e}")

    def response(self, flow: http.HTTPFlow):
        if flow.request.pretty_host not in BASE_HOSTS:
            return
        if not flow.request.path.startswith("/v3/api.php/"):
            return
        method_path = flow.request.path[len("/v3/api.php/"):]
        try:
            txt = flow.response.get_text() or ""
            resp_json = safe_json(txt)
            decoded_data = None
            status = None
            info = None
            if isinstance(resp_json, dict):
                status = resp_json.get("status")
                info = resp_json.get("info")
                if "data" in resp_json and isinstance(resp_json["data"], str) and resp_json["data"]:
                    # status===1 时 data 是 AES 密文；其它分支可能是错误描述
                    if status == 1:
                        try:
                            decoded_data = aes_decrypt(resp_json["data"])
                        except Exception:
                            decoded_data = None
                    elif isinstance(resp_json.get("data"), str):
                        decoded_data = resp_json["data"]
                elif isinstance(resp_json, str):
                    # 整串密文（旧式）
                    try:
                        decoded_data = aes_decrypt(resp_json)
                    except Exception:
                        pass
            elif isinstance(resp_json, str):
                try:
                    decoded_data = aes_decrypt(resp_json)
                except Exception:
                    pass

            if not self.quiet:
                log.info(f"[RESP] {method_path} status={status} info={info}")
                if decoded_data:
                    log.info(f"  resp: {decoded_data[:200]}")

            if self.log_enabled:
                fp = self._open_log()
                fp.write(json.dumps({
                    "ts": datetime.datetime.now().isoformat(timespec="seconds"),
                    "dir": "RESP",
                    "method_path": method_path,
                    "status": status,
                    "info": info,
                    "decoded": decoded_data,
                }, ensure_ascii=False) + "\n")
                fp.flush()

            # 提取登录态
            if method_path in LOGIN_METHODS and decoded_data:
                self._extract_login(method_path, decoded_data)
        except Exception as e:
            log.debug(f"response decode skipped: {e}")

    def _flatten(self, obj, prefix=""):
        """递归展开嵌套 dict/list，收集所有叶子字段。
        兼容 loginByCode 的 token_data.access_token、UserInfo 的 user、index 的 term_name 等多种结构。"""
        flat = {}
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, dict):
                    # token_data.access_token → token
                    if k == "token_data" and isinstance(v, dict):
                        for kk, vv in v.items():
                            flat.setdefault("token" if kk == "access_token" else kk, vv)
                    for kk, vv in self._flatten(v).items():
                        flat.setdefault(kk, vv)
                elif isinstance(v, list):
                    for item in v:
                        if isinstance(item, dict):
                            for kk, vv in self._flatten(item).items():
                                flat.setdefault(kk, vv)
                else:
                    flat.setdefault(k, v)
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, dict):
                    for kk, vv in self._flatten(item).items():
                        flat.setdefault(kk, vv)
        return flat

    def _extract_login(self, method_path, decoded):
        obj = safe_json(decoded)
        if not obj:
            return

        flat = self._flatten(obj)

        # 直接命中的字段
        patch = {}
        for f in COMMON_FIELDS:
            if f in flat and flat[f] not in (None, "", 0):
                patch[f] = flat[f]

        # WpRun/getTermList 返回 [{term_id, term_name, status}, ...]，取 status=="1" 的当前学期
        if "term_id" not in patch and method_path == "WpRun/getTermList":
            if isinstance(obj, list):
                cur = next((t for t in obj if str(t.get("status")) == "1"), None) or (obj[0] if obj else None)
                if isinstance(cur, dict):
                    patch["term_id"] = cur.get("term_id") or cur.get("id")
            elif isinstance(obj, dict):
                patch["term_id"] = obj.get("term_id") or obj.get("id")

        # course_id 常在 WpIndex/index 或 loginByCode 里，若无则留空待 auto-run 用 beforeRunV260 补
        # school_id 在 UserInfo/index/loginByCode 都可能有

        # card_id 缺失则用 student_num
        if "student_num" in patch and not patch.get("card_id"):
            patch["card_id"] = patch["student_num"]

        if not patch:
            if not self.quiet:
                log.info(f"[login] {method_path} 未提取到新登录态字段")
            return

        # 只保留本次新增/变化的字段，避免重复打印全部
        new_patch = {k: v for k, v in patch.items() if self.captured.get(k) != v}
        self.captured.update(patch)

        if new_patch:
            log.info(f"[login] {method_path} 新增: {json.dumps(new_patch, ensure_ascii=False)}")
        else:
            log.debug(f"[login] {method_path} 无新增字段")

        if self.write_config and new_patch:
            self._write_config(self.captured)
            # 打印当前完整度
            self._log_completeness()
        elif self.write_config and patch:
            # patch 全是旧值也补写一次保证文件齐全
            self._write_config(self.captured)

    def _log_completeness(self):
        """打印 config.json 当前各字段是否齐全，提示用户还差什么。"""
        have = set(self.captured.keys())
        need = set(COMMON_FIELDS)
        missing = need - have
        if not missing:
            log.info(f"[✓] 登录态已齐全：{', '.join(sorted(need))}")
        else:
            log.info(f"[…] 已有: {', '.join(sorted(have & need)) or '(无)'}")
            log.info(f"[…] 还缺: {', '.join(sorted(missing))}（继续在小程序里操作以触发相应接口）")


    def _write_config(self, patch):
        cfg = {}
        if CONFIG_PATH.exists():
            try:
                cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                cfg.pop("_comment", None)
                cfg.pop("_comment_run", None)
                if isinstance(cfg.get("run"), dict):
                    cfg["run"].pop("_comment", None)
            except Exception:
                cfg = {}
        # 保留已有 run 配置
        cfg.update(patch)
        cfg.setdefault("baseUrl", "https://tyxyzhpt.tyut.edu.cn")
        # 保留 run / mobileModel 等
        cfg.setdefault("mobileModel", cfg.get("mobileModel", "iPhone14,3"))
        cfg.setdefault("run", {
            "distanceKm": 3.0, "usedTimeS": 700,
            "centerLat": 37.87, "centerLon": 112.55, "areaCode": None,
        })
        # 重新加注释
        out = {
            "_comment": "由 happyrun-capture.py 自动生成。请核对字段后即可用 auto-run.mjs。",
            **cfg,
        }
        CONFIG_PATH.write_text(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        log.info(f"[login] 已写回 {CONFIG_PATH}")


addons = [HappyrunCapture()]


