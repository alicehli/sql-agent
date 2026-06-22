#!/usr/bin/env python3
"""
Modal sandbox ops for the comparison demo (lane A: generic sandbox, DIY connectors).

Node shells out to this with the project's .modal-venv python. Modal's SDK is
Python-only, so this is the bridge. Sandboxes are reconnected by id between calls
via Sandbox.from_id, so each op is a short-lived subprocess (no persistent sidecar).

Usage:
  python modal_op.py create
  python modal_op.py exec  <sandbox_id>   # python code on stdin (base64)
  python modal_op.py kill  <sandbox_id>

Output: a single line "__MODAL__<base64(json)>" so the Node side can parse it
regardless of other stdout noise.
"""
import os
import sys
import json
import base64

MARK = "__MODAL__"
APP_NAME = "sandcastle-cmp"


def out(d):
    print(MARK + base64.b64encode(json.dumps(d).encode()).decode())


def main():
    import modal

    op = sys.argv[1] if len(sys.argv) > 1 else ""

    if op == "create":
        app = modal.App.lookup(APP_NAME, create_if_missing=True)
        # DIY image: the libs a data engineer would reach for. First build is slow
        # (cached after) — which is itself part of the "generic sandbox" story.
        image = modal.Image.debian_slim().pip_install(
            "pandas", "numpy", "matplotlib", "psycopg2-binary", "sqlalchemy",
            "snowflake-connector-python",
        )
        # Pass any SNOWFLAKE_* creds into the sandbox so the DIY lane can connect.
        snow = {k: v for k, v in os.environ.items() if k.startswith("SNOWFLAKE_")}
        secrets = [modal.Secret.from_dict(snow)] if snow else []
        # Keep alive across follow-up turns; auto-cleans after idle timeout.
        sb = modal.Sandbox.create(app=app, image=image, timeout=900, secrets=secrets)
        out({"sandbox_id": sb.object_id})

    elif op == "exec":
        sb_id = sys.argv[2]
        code = base64.b64decode(sys.stdin.read().encode()).decode()
        sb = modal.Sandbox.from_id(sb_id)
        p = sb.exec("python3", "-c", code)
        stdout = p.stdout.read()
        stderr = p.stderr.read()
        rc = p.wait()
        out({"stdout": stdout, "stderr": stderr, "exit_code": rc})

    elif op == "kill":
        modal.Sandbox.from_id(sys.argv[2]).terminate()
        out({"ok": True})

    else:
        out({"error": "unknown op: %r" % op})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # surface errors as a parseable result, not a crash
        out({"error": str(e)})
