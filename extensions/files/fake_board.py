#!/usr/bin/env python3
"""A fake serial board for tests: a pseudo-terminal that answers like a
MicroPython board with a small JSON line-protocol firmware.

Prints the slave device path on the first line, then serves until stdin
closes. Commands are lines; control bytes are handled as MicroPython does.

  ping           -> {"ok": true, "fw": "fake 0.1"}\\r\\n
  quiet          -> no reply at all
  slow           -> "part1", 300 ms pause, "part2\\r\\n"  (exercises idle)
  spew           -> three lines 40 ms apart, no delimiter   (exercises idle)
  \\x03           -> "\\r\\nKeyboardInterrupt\\r\\n>>> "
  \\x01           -> "raw REPL; CTRL-B to exit\\r\\n>"
  \\x02           -> "\\r\\n>>> "
  <code>\\x04     -> "OK" + "ran\\r\\n" + "\\x04" + "\\x04" + ">"   (raw REPL exec)
  \\x04 (normal)  -> soft reset banner + '{"ok": true, "fw": "fake 0.1"}\\r\\n'
"""
import json
import os
import pty
import select
import sys
import time

master, slave = pty.openpty()
print(os.ttyname(slave), flush=True)

raw = False
buf = b""


def send(b: bytes):
    os.write(master, b)


while True:
    r, _, _ = select.select([master, sys.stdin], [], [], 0.05)
    if sys.stdin in r:
        if not sys.stdin.readline():
            break  # test is done
    if master not in r:
        continue
    try:
        data = os.read(master, 1024)
    except OSError:
        break
    if not data:
        break
    buf += data
    while buf:
        if buf[0:1] == b"\x03":
            buf = buf[1:]
            raw = False
            send(b"\r\nKeyboardInterrupt\r\n>>> ")
        elif buf[0:1] == b"\x01":
            buf = buf[1:]
            raw = True
            send(b"raw REPL; CTRL-B to exit\r\n>")
        elif buf[0:1] == b"\x02":
            buf = buf[1:]
            raw = False
            send(b"\r\n>>> ")
        elif raw and b"\x04" in buf:
            code, _, buf = buf.partition(b"\x04")
            if b"1/0" in code:
                send(b"OK\x04Traceback (most recent call last):\r\nZeroDivisionError: divide by zero\r\n\x04>")
            else:
                send(b"OKran " + code.strip() + b"\r\n\x04\x04>")
        elif not raw and buf[0:1] == b"\x04":
            buf = buf[1:]
            send(b"MPY: soft reboot\r\n" + b'{"ok": true, "fw": "fake 0.1"}\r\n')
        elif b"\n" in buf:
            line, _, buf = buf.partition(b"\n")
            cmd = line.strip()
            if cmd.startswith(b"{"):
                # UC2-style structured request: {"task":"/x","qid":N,...}
                try:
                    req = json.loads(cmd)
                except Exception:
                    req = None
                if req and "task" in req and "qid" in req and str(req["task"]).startswith("/"):
                    q = req["qid"]
                    t = req["task"]
                    if str(t).endswith("_get"):
                        send(('{"qid": %d, "value": 42, "task": %s}\r\n' % (q, json.dumps(t))).encode())
                    else:
                        send(('{"qid": %d}\r\n' % q).encode())          # ACK
                        time.sleep(0.05)
                        send(('{"qid": %d, "progress": 50}\r\n' % q).encode())  # event
                        time.sleep(0.05)
                        send(('{"qid": %d, "result": "done", "success": 1, "task": %s}\r\n' % (q, json.dumps(t))).encode())  # DONE
                elif req is not None:
                    send(b'{"ok": false, "error": "bad request"}\r\n')
            elif cmd == b"ping":
                send(b'{"ok": true, "fw": "fake 0.1"}\r\n')
            elif cmd == b"quiet":
                pass
            elif cmd == b"slow":
                send(b"part1")
                time.sleep(0.3)
                send(b"part2\r\n")
            elif cmd == b"spew":
                for i in range(3):
                    send(b"line %d\r\n" % i)
                    time.sleep(0.04)
            elif cmd:
                send(b'{"ok": false, "error": "unknown command"}\r\n')
        else:
            break  # wait for more bytes
