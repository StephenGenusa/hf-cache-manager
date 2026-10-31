#!/usr/bin/env python3
"""Reference vectors for the TypeScript pyjson helpers. Standard library only.

usage: pyjson_vectors.py <inputs.json>      (prints expected.json on stdout)
inputs.json:   { "json": [<JSON text>, ...], "quote": [<string>, ...] }
expected.json: { "json": [{ "indent1", "compact", "default" }, ...], "quote": [...] }
"""
import json
import sys
import urllib.parse


def main(argv: list) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as f:
        inputs = json.load(f)
    out = {
        "json": [
            {
                "indent1": json.dumps(json.loads(t), indent=1),
                "compact": json.dumps(json.loads(t), separators=(",", ":")),
                "default": json.dumps(json.loads(t)),
            }
            for t in inputs["json"]
        ],
        "quote": [urllib.parse.quote(s, safe="") for s in inputs["quote"]],
    }
    sys.stdout.write(json.dumps(out, indent=1))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
