#!/usr/bin/env python3
"""追踪第三方阅卷扩展（Edge Add-ons）版本更新，下载新版并生成与上一版的差异报告。

用法:
    python3 -I tools/track_third_party_grader.py            # 检查并处理新版本
    python3 -I tools/track_third_party_grader.py --seed 1.9.13 research/third-party-grader.crx
                                                     # 把已有 CRX 登记为基线版本
产物: research/versions/<版本>/{third-party-grader-<版本>.crx, unpacked/, pretty/, report.md, *.diff}
"""
import argparse, difflib, hashlib, io, json, re, shutil, subprocess, sys, urllib.request, zipfile
from pathlib import Path

CRX_ID = "hhflnhodhiakgaiahhcnkklbcjiokiap"
DETAIL_URL = f"https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/{CRX_ID}?hl=zh-CN&gl=CN"
CRX_URL = ("https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect"
           f"&x=id%3D{CRX_ID}%26installsource%3Dondemand%26uc")
ROOT = Path(__file__).resolve().parent.parent
VERSIONS = ROOT / "research" / "versions"
PRETTIER = ROOT / "tools" / "node_modules" / "prettier" / "bin" / "prettier.cjs"
PRETTY_FILES = ["background.js", "content.js", "insert.js"]


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Edg/140.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def vkey(v: str):
    return tuple(int(x) if x.isdigit() else x for x in re.split(r"[.]", v))


def crx_to_zip(data: bytes) -> bytes:
    """CRX3: 'Cr24' | uint32 version | uint32 header_size | header | zip"""
    if data[:4] != b"Cr24":
        raise ValueError("不是 CRX 文件")
    header_size = int.from_bytes(data[8:12], "little")
    return data[12 + header_size:]


def safe_extract(zip_bytes: bytes, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for info in z.infolist():
            target = (dest / info.filename).resolve()
            if not str(target).startswith(str(dest.resolve())):
                raise ValueError(f"可疑路径: {info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(info))


def prettify(unpacked: Path, pretty: Path):
    pretty.mkdir(parents=True, exist_ok=True)
    for name in PRETTY_FILES:
        src = unpacked / name
        if not src.exists():
            continue
        out = subprocess.run(["node", str(PRETTIER), "--parser", "babel", str(src)],
                             capture_output=True, text=True)
        (pretty / name).write_text(out.stdout if out.returncode == 0 else src.read_text())
# ---------- 语义抽取（不依赖混淆后的变量名，便于跨版本对比） ----------
STR_RE = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"")
SEL_CALL_RE = re.compile(
    r"\.(querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName|closest)"
    r"\(\s*(['\"])((?:(?!\2).)*)\2", re.S)
FUNC_DEF_RE = re.compile(r"^\s*([A-Za-z$_][\w$]*) = (?:async )?function\b", re.M)
API_RE = re.compile(r"^\s*([A-Za-z]\w*): '(/(?:judge|order|pay|inviter|activity|privacy)/[\w/]+)'", re.M)


def string_literals(text: str) -> set:
    return {a or b for a, b in STR_RE.findall(text) if (a or b)}


def block_from(text: str, start: int) -> str:
    """从 start 之后第一个 '{' 开始做括号匹配，粗略跳过字符串。"""
    i = text.find("{", start)
    if i < 0:
        return ""
    depth, j, q = 0, i, None
    while j < len(text):
        c = text[j]
        if q:
            if c == "\\":
                j += 1
            elif c == q:
                q = None
        elif c in "'\"`":
            q = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[i:j + 1]
        j += 1
    return text[i:]


def func_index(text: str) -> dict:
    return {m.group(1): m.start() for m in FUNC_DEF_RE.finditer(text)}


def selectors_of(text: str, funcs: dict, name: str, depth: int = 2, seen=None) -> set:
    seen = seen if seen is not None else set()
    if name in seen or name not in funcs:
        return set()
    seen.add(name)
    body = block_from(text, funcs[name])
    sels = {m.group(3) for m in SEL_CALL_RE.finditer(body)}
    # 配置对象写法: { selectors: ['img.ansImg', ...], picType: 'img' }
    for arr in re.findall(r"selectors:\s*\[([^\]]*)\]", body):
        sels |= {a or b for a, b in STR_RE.findall(arr)}
    if depth > 0:
        for callee in set(re.findall(r"\b([A-Za-z$_][\w$]{1,3})\(", body)):
            sels |= selectors_of(text, funcs, callee, depth - 1, seen)
    return sels


def adapter_routes(text: str) -> dict:
    """解析 Cae() 里的平台路由三元链: {条件串: {方法: 选择器集合}}"""
    m = re.search(r"^\s*[A-Za-z$_][\w$]* = async function \(e = !1\) \{\s*let t = window\.location\.hostname", text, re.M)
    if not m:
        return {}
    body = block_from(text, m.start())
    funcs = func_index(text)
    routes, cur, pending = {}, "?", []
    # 三元链: cond ? ((n.a = X), ...) : cond2 ? (...) : ((n.a = Y), ...)   最后一个 ':' 分支为默认 compat
    tokens = re.finditer(
        r"(?:\.includes\(\s*'([^']+)'|'([^']+)'\s*===?\s*[et]\b|\b[et]\s*===?\s*'([^']+)')"  # 1-3: 条件
        r"|([?:])\s*\(+\s*n\."                       # 4: 分支起点
        r"|n\.(\w+) =\s*([A-Za-z$_][\w$]*)", body)   # 5,6: 赋值
    for t in tokens:
        cond = t.group(1) or t.group(2) or t.group(3)
        if cond:
            pending.append(cond)
            continue
        if t.group(4):
            cur = " | ".join(pending) if t.group(4) == "?" else "default(fallback)"
            pending = []
            # 分支起点的正则吃掉了第一个赋值的 "n."，这里补抓
            m2 = re.match(r"[?:]\s*\(+\s*n\.(\w+) =\s*([A-Za-z$_][\w$]*)", body[t.start():])
            if m2:
                routes.setdefault(cur, {})[m2.group(1)] = sorted(selectors_of(text, funcs, m2.group(2)))
        elif t.group(5):
            routes.setdefault(cur, {})[t.group(5)] = sorted(selectors_of(text, funcs, t.group(6)))
    return routes


def extract(pkg: Path) -> dict:
    unpacked, pretty = pkg / "unpacked", pkg / "pretty"
    manifest = json.loads((unpacked / "manifest.json").read_text(encoding="utf-8-sig"))
    content = (pretty / "content.js").read_text()
    bg = (pretty / "background.js").read_text()
    matches = sorted({p for cs in manifest.get("content_scripts", []) for p in cs.get("matches", [])})
    files = {}
    for f in sorted(unpacked.rglob("*")):
        if f.is_file() and "_metadata" not in f.parts:
            files[str(f.relative_to(unpacked))] = {
                "size": f.stat().st_size, "sha256": hashlib.sha256(f.read_bytes()).hexdigest()[:16]}
    return {
        "version": manifest["version"],
        "matches": matches,
        "permissions": sorted(manifest.get("permissions", []) + manifest.get("optional_permissions", [])),
        "api": dict(sorted(API_RE.findall(content) + API_RE.findall(bg))),
        "routes": adapter_routes(content),
        "strings": sorted(string_literals(content) | string_literals(bg)),
        "files": files,
    }
# ---------- 报告 ----------
def set_diff(title: str, old, new, limit: int = 300) -> list:
    old, new = set(old), set(new)
    add, rm = sorted(new - old), sorted(old - new)
    if not add and not rm:
        return []
    out = [f"### {title}（+{len(add)} / -{len(rm)}）", ""]
    out += [f"- `+ {x}`" for x in add[:limit]] + [f"- `- {x}`" for x in rm[:limit]]
    if len(add) > limit or len(rm) > limit:
        out.append(f"- …（截断，完整见 extract.json）")
    return out + [""]


def report(old: dict, new: dict) -> str:
    lines = [f"# 第三方阅卷扩展 {old['version']} → {new['version']}", ""]
    lines += set_diff("content_scripts 匹配域名", old["matches"], new["matches"])
    lines += set_diff("权限", old["permissions"], new["permissions"])
    lines += set_diff("API 接口", [f"{k} {v}" for k, v in old["api"].items()],
                      [f"{k} {v}" for k, v in new["api"].items()])
    lines += set_diff("平台路由（Cae 适配分支）", old["routes"], new["routes"])
    for plat in sorted(set(new["routes"]) - set(old["routes"])):
        lines += [f"## 新平台选择器：{plat or '(空条件)'}", ""]
        for meth, sels in new["routes"][plat].items():
            if sels:
                lines.append(f"- {meth}: " + ", ".join(f"`{s}`" for s in sels))
        lines.append("")
    for plat in sorted(set(old["routes"]) & set(new["routes"])):
        o, n = old["routes"][plat], new["routes"][plat]
        sub = []
        for meth in sorted(set(o) | set(n)):
            sub += set_diff(f"{plat} · {meth}", o.get(meth, []), n.get(meth, []))
        if sub:
            lines += [f"## 选择器变化：{plat}", ""] + [s.replace("### ", "#### ", 1) for s in sub]
    lines += set_diff("新增/删除的字符串字面量（提示文案、埋点事件、选择器等）",
                      old["strings"], new["strings"], limit=200)
    changed = [f"- `{f}` {old['files'].get(f, {}).get('size', '-')} → {new['files'].get(f, {}).get('size', '-')} bytes"
               for f in sorted(set(old["files"]) | set(new["files"]))
               if old["files"].get(f, {}).get("sha256") != new["files"].get(f, {}).get("sha256")]
    if changed:
        lines += ["### 文件变化", ""] + changed + [""]
    lines += ["完整代码差异见同目录 `*.diff`（基于 prettier 格式化结果）。", ""]
    return "\n".join(lines)


def write_code_diffs(old_pkg: Path, new_pkg: Path):
    for name in PRETTY_FILES:
        a, b = old_pkg / "pretty" / name, new_pkg / "pretty" / name
        if not (a.exists() and b.exists()):
            continue
        diff = difflib.unified_diff(a.read_text().splitlines(), b.read_text().splitlines(),
                                    f"{old_pkg.name}/{name}", f"{new_pkg.name}/{name}", lineterm="", n=3)
        (new_pkg / f"{name}.diff").write_text("\n".join(diff) + "\n")


# ---------- 流程 ----------
def ingest(version: str, crx: bytes) -> Path:
    pkg = VERSIONS / version
    if pkg.exists():
        shutil.rmtree(pkg)
    pkg.mkdir(parents=True)
    (pkg / f"third-party-grader-{version}.crx").write_bytes(crx)
    safe_extract(crx_to_zip(crx), pkg / "unpacked")
    real = json.loads((pkg / "unpacked" / "manifest.json").read_text(encoding="utf-8-sig"))["version"]
    if real != version:
        raise SystemExit(f"版本不符：期望 {version}，包内为 {real}")
    prettify(pkg / "unpacked", pkg / "pretty")
    data = extract(pkg)
    (pkg / "extract.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
    return pkg


def known_versions() -> list:
    if not VERSIONS.exists():
        return []
    return sorted((p.name for p in VERSIONS.iterdir() if (p / "extract.json").exists()), key=vkey)


def diff_against_previous(pkg: Path):
    vers = [v for v in known_versions() if vkey(v) < vkey(pkg.name)]
    if not vers:
        print("没有更早的版本，跳过对比")
        return
    prev = VERSIONS / vers[-1]
    old, new = (json.loads((p / "extract.json").read_text()) for p in (prev, pkg))
    (pkg / "report.md").write_text(report(old, new))
    write_code_diffs(prev, pkg)
    print(f"报告: {pkg / 'report.md'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", nargs=2, metavar=("VERSION", "CRX"), help="登记本地已有 CRX 为某个版本")
    ap.add_argument("--rediff", metavar="VERSION", help="仅重新抽取并生成某版本的报告")
    ap.add_argument("--force", action="store_true", help="即使版本已存在也重新下载")
    args = ap.parse_args()

    if args.seed:
        pkg = ingest(args.seed[0], Path(args.seed[1]).read_bytes())
        print(f"已登记 {pkg}")
        return
    if args.rediff:
        pkg = VERSIONS / args.rediff
        (pkg / "extract.json").write_text(json.dumps(extract(pkg), ensure_ascii=False, indent=1))
        diff_against_previous(pkg)
        return

    detail = json.loads(http_get(DETAIL_URL))
    latest = detail["version"]
    have = known_versions()
    print(f"商店最新版本 {latest}，本地已有 {have or '无'}")
    if latest in have and not args.force:
        print("没有新版本")
        return
    pkg = ingest(latest, http_get(CRX_URL, timeout=120))
    print(f"已下载并解包 {pkg}")
    diff_against_previous(pkg)


if __name__ == "__main__":
    sys.exit(main())
