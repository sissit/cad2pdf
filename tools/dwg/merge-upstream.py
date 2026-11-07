#!/usr/bin/env python3
"""Settle the merge of upstream LibreDWG into mlightcad/libredwg-web (run inside that checkout).

Used by .github/workflows/build-dwg-reader.yml. The web bindings are a fork of LibreDWG; newer
LibreDWG reads DWG files that the fork's reader cannot (it runs out of memory on them), so the
backup reader is the fork with upstream merged in. Three files conflict:

  src/decode.c    keep the fork's object_ref growth (it tracks the allocated size)
  src/dwg_api.c   take upstream's POLYLINE_2D vertex walk (it stops at the last vertex)
  .github/workflows/main.yml   upstream's CI, not needed here

It also rewrites the bindings' error messages for unknown field names without std::ostringstream:
in this build an ostringstream aborts the whole reader, so asking for any field a DWG object does
not have (the converter does that routinely) killed the read instead of returning "no such field".
"""
import re
import subprocess
import sys

KEEP = {"src/decode.c": "ours", "src/dwg_api.c": "theirs"}
PAT = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)

for path, side in KEEP.items():
    with open(path) as f:
        text = f.read()
    text, n = PAT.subn(lambda m: m.group(1) if side == "ours" else m.group(2), text)
    with open(path, "w") as f:
        f.write(text)
    print(f"{path}: {n} conflict(s), kept {side}")

B = "bindings/javascript/embind/binding_dynapi.cpp"
with open(B) as f:
    src = f.read()
def _msg(m):
    parts = [x.strip() for x in m.group(2).split("<<")]
    return m.group(1) + "std::string ss_msg = std::string() + " + " + ".join(parts) + ";"
src, n1 = re.subn(r"([ \t]*)std::ostringstream ss;\n[ \t]*ss << (.*?);", _msg, src)
src = src.replace("ss.str()", "ss_msg")
with open(B, "w") as f:
    f.write(src)
print(f"{B}: {n1} error message(s) without ostringstream")
if "ostringstream" in src:
    sys.exit("ostringstream still used in " + B)

subprocess.run(["git", "rm", "-q", "--ignore-unmatch", ".github/workflows/main.yml"], check=False)
subprocess.run(["git", "add", "-A", "src", "bindings"], check=True)
left = subprocess.run(["git", "diff", "--name-only", "--diff-filter=U"], capture_output=True, text=True).stdout.split()
if left:
    sys.exit("unresolved conflicts: " + " ".join(left))
subprocess.run(["git", "-c", "user.email=ci@localhost", "-c", "user.name=ci", "commit", "-qm", "merge upstream LibreDWG"], check=True)
print("merge settled")
