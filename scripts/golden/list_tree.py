#!/usr/bin/env python3
"""Tree listing of a view, byte-identical to tests/golden/tree-listing.ts. Standard library only.

usage: list_tree.py <root> <hub> <case dir> <out prefix>
writes <out prefix>.tree and <out prefix>.state.json (the masked state file text, empty when there is none).

One line per entry under <root>, sorted by the UTF-8 bytes of the relative path:
  <rel>\\tD | <rel>\\tL\\t<link text> | <rel>\\tF\\t<size>\\t<sha256>
The link text has the real hub path replaced by @HUB@, then the case dir by @CASE@. Symlinks are never followed.
Timestamps in .hfhub-state.json become "@TIME@" before the size and hash are taken.
"""
import hashlib
import os
import re
import sys

STATE_NAME = ".hfhub-state.json"
TIME = re.compile(r'"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d"')


def mask(data: bytes) -> bytes:
    return TIME.sub('"@TIME@"', data.decode("utf-8")).encode("utf-8")


def listing(root: str, hub_real: str, case_dir: str) -> str:
    rows = []

    def walk(abs_dir: str, rel: str) -> None:
        for name in os.listdir(abs_dir):
            p = os.path.join(abs_dir, name)
            r = name if rel == "" else rel + "/" + name
            if os.path.islink(p):
                text = os.readlink(p).replace(hub_real, "@HUB@").replace(case_dir, "@CASE@")
                rows.append((r, f"{r}\tL\t{text}"))
            elif os.path.isdir(p):
                rows.append((r, f"{r}\tD"))
                walk(p, r)
            else:
                with open(p, "rb") as f:
                    data = f.read()
                if name == STATE_NAME:
                    data = mask(data)
                rows.append((r, f"{r}\tF\t{len(data)}\t{hashlib.sha256(data).hexdigest()}"))

    walk(root, "")
    rows.sort(key=lambda row: row[0].encode("utf-8", "surrogateescape"))
    return "".join(line + "\n" for _, line in rows)


def main(argv: list) -> int:
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    root, hub, case, prefix = argv[1], os.path.realpath(argv[2]), os.path.realpath(argv[3]), argv[4]
    with open(prefix + ".tree", "w", encoding="utf-8", newline="") as f:
        f.write(listing(os.path.realpath(root), hub, case))
    state = os.path.join(root, STATE_NAME)
    text = mask(open(state, "rb").read()).decode("utf-8") if os.path.isfile(state) else ""
    with open(prefix + ".state.json", "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
