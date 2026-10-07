# -*- coding: utf-8 -*-
"""
Bundle the LG红果 (hongguo-webos) project source into ONE markdown file for IMA.

IMA's upload whitelist has no `zip`, and its source-upload guidance is explicit:
concatenate into a single `.md`, one section per file, fenced with FOUR backticks
(the bundled source can itself contain three-backtick fences, which would
otherwise break the document). A file manifest goes at the top so the bundle is
searchable and verifiable.

Usage:
    python bundle-for-ima.py <repo-root> <out.md>
"""
import hashlib
import os
import subprocess
import sys

# Directory prefixes to skip inside the bundle. The repo tracks a lot of
# one-off TV diagnostic probes and captured JSON; they are useful in git, but
# they would swamp the project itself in a knowledge-base document.
SKIP_PREFIXES = (
    "tools/out-",
    "tools/_buf",
)
SKIP_EXACT = {
    "tools/_qr-test.png",
}

LANG_BY_EXT = {
    ".js": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".css": "css",
    ".html": "html",
    ".sh": "bash",
    ".py": "python",
    ".md": "markdown",
    ".txt": "text",
    ".cjs": "javascript",
}

BINARY_EXT = {".png", ".jpg", ".jpeg", ".webp", ".ipk"}


def lang_for(path):
    _, ext = os.path.splitext(path)
    return LANG_BY_EXT.get(ext.lower(), "")


def listed_files(root):
    out = subprocess.run(
        ["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True
    ).stdout
    files = []
    for line in out.splitlines():
        rel = line.strip()
        if not rel:
            continue
        if rel in SKIP_EXACT or any(rel.startswith(p) for p in SKIP_PREFIXES):
            continue
        files.append(rel.replace("\\", "/"))
    return files


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    root, out_path = sys.argv[1], sys.argv[2]

    files = listed_files(root)
    rows = []
    sections = []

    for rel in files:
        abs_path = os.path.join(root, *rel.split("/"))
        _, ext = os.path.splitext(rel)
        if ext.lower() in BINARY_EXT:
            size = os.path.getsize(abs_path)
            digest = hashlib.sha256(open(abs_path, "rb").read()).hexdigest()[:12]
            rows.append((rel, size, digest, "-"))
            sections.append(
                "### `%s`\n\n"
                "binary file, %d bytes, sha256:%s — not inlined.\n" % (rel, size, digest)
            )
            continue

        raw = open(abs_path, "rb").read()
        size = len(raw)
        digest = hashlib.sha256(raw).hexdigest()[:12]
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        lines = text.count("\n") + (0 if text.endswith("\n") else 1)
        rows.append((rel, size, digest, str(lines)))

        fence = "````"
        lang = lang_for(rel)
        # Never let the closing fence collide with content.
        body = text.rstrip("\n")
        sections.append(
            "### `%s`\n\n%s%s\n%s\n\n%s\n" % (rel, fence, lang, body, fence)
        )

    total_bytes = sum(r[1] for r in rows)

    head = []
    head.append("# 红果短剧 · LG webOS 客户端 —— 项目源码包\n\n")
    head.append(
        "本文档是 **hongguo-webos** 项目的完整源码快照，由受版本控制（git）的文件清单生成，\n"
        "不含 `node_modules/`、构建产物 `dist/`，以及本机地址等敏感信息。\n\n"
    )
    head.append(
        "| 项 | 值 |\n| --- | --- |\n"
        "| 文件数 | %d |\n"
        "| 源码总字节 | %d |\n"
        "| 生成方式 | bundle-for-ima.py |\n\n" % (len(rows), total_bytes)
    )
    head.append("每个文件一段，围栏用四个反引号（源码里可能出现三个反引号）。\n\n")
    head.append("## 文件清单\n\n")
    head.append("| 路径 | 字节 | sha256(前12) | 行数 |\n| --- | ---: | --- | ---: |\n")
    for rel, size, digest, lines in rows:
        head.append("| `%s` | %d | `%s` | %s |\n" % (rel, size, digest, lines))

    head.append("\n---\n\n## 源码\n\n")

    doc = "".join(head) + "\n".join(sections) + "\n"
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(doc)

    print("files: %d" % len(rows))
    print("bytes(inlined): %d" % total_bytes)
    print("out bytes: %d" % os.path.getsize(out_path))
    print("out: %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
