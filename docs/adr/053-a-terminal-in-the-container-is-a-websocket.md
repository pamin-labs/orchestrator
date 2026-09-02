# 053 A terminal in the container is a WebSocket, not a Python script

**Status**: accepted. Replaces the pty runner introduced with the container
login in `597d1460`.
**Date**: 2026-09-02

## Context

`claude setup-token` is a TUI. Without a terminal it prints nothing useful, and
the credential it mints is the only way a subscription account reaches a
sandbox. When the login moved off the host and into the utility container, the
SDK offered a command runner and no terminal, so one was built: a 38-line Python
script uploaded to `/opt/orch/pty.py`, run under `python3`, which forks a pty,
sets the window size with `ioctl`, and reads the boss's pasted code out of a
file this process appends to.

Every line of that was a workaround for something the transport did not have,
and each one failed in its own way. In the order they were found:

- `import pty` in a script named `pty.py` resolves to the script. Every
  `claude setup-token` since 2026-08-15 died on line four and was reported as
  "the CLI needs a pty", which the login was supplying.
- Renaming it to `login-pty.py` was not enough: `/opt/orch` outlives the server
  that writes into it, so the old file stayed beside the new one and `import
  pty` still found it. Fixed with `python3 -P`.
- The pasted code was written into the pty ending in LF. Enter on a terminal is
  CR.
- Sending the code and the CR in one `os.write` submits nothing: the CLI turns
  on bracketed paste, so that arrives as one paste and the CR inside it is
  content. A ten-character code happened to land as two reads and looked like it
  worked; a real ninety-two-character one did not.
- The stream outlives the process. `realLines` closes its queue when the SDK's
  `run()` promise settles, and measured on a live server it did not settle after
  the CLI had exited — no process left in the container, the stream still open.
  Nothing concluded, so the panel was told nothing at all.
- `cancel()` aborts the HTTP request and does not stop the command, so `done`
  stays pending and the get-or-create slot stays occupied by a dead run.

The last two were patched at the login layer — stop reading on a printed token,
bound the wait after a submit with `timeouts.loginVerdictMs`, release the slot in
`cancel()`. Those are compensations. They make the panel always end up with
something to say; they do not give the transport an ending.

## The transport already has all of it

execd — the daemon OpenSandbox injects into every container — ships a PTY over
WebSocket, reachable through the sandbox server's proxy. Verified end to end
against a real server before this was written:

```
POST /v1/sandboxes/{id}/proxy/44772/pty   → 201 {"session_id":"…"}
WS   /v1/sandboxes/{id}/proxy/44772/pty/{session_id}/ws
     ← {"type":"connected","session_id":"…","mode":"pty"}
     → {"type":"resize","cols":400,"rows":200}
     → 0x00 + raw bytes                      (stdin)
     ← 0x01 + raw bytes                      (stdout)
     ← {"type":"exit","exit_code":0}
     close 1000
```

`{"type":"signal","signal":"SIGINT"}` is in the same control channel. The proxy
is auth-exempt, so no second credential is involved.

It is not in the SDK. `RunCommandOpts` has `workingDirectory`, `background`,
`timeoutSeconds`, `uid`, `gid` and `envs` and nothing else; the word `stdin`
appears once in the package, inside a docstring's example traceback. The
capability is in the daemon and the SDK has not wrapped it yet — upstream
issue 992 is titled "document it + SDK helper".

## Decision

The login opens a PTY session over that WebSocket and drives the CLI through it.
`src/mech/sandbox/pty.ts` owns the wire format and nothing else knows it.

What that deletes, rather than fixes:

| Workaround | Replaced by |
|---|---|
| `PTY_RUNNER`, uploaded and run per login | the daemon's own pty |
| the `pty.py` name collision, and `-P` | no script to collide |
| `ioctl(TIOCSWINSZ, …)` | `{"type":"resize"}` |
| the inbox file, `readline`, `execIn` append | `0x00` + bytes |
| a stream with no ending | `{"type":"exit"}` and a close frame |
| `cancel()` that stops nothing | `{"type":"signal","signal":"SIGINT"}` |
| `timeouts.loginVerdictMs` | the exit frame is the verdict |

Two things do **not** change, and saying so is the point of writing this down.
The CLI still performs the entire OAuth exchange: no client id of ours, no URL
we build, no call to a token endpoint. And the code still goes in as two writes,
because bracketed paste is the CLI's behaviour and not the transport's.

`execLines` keeps `run()` for everything else. A turn, a gate and a lease want a
command's output and its exit code; they do not want a terminal, and giving them
one would mean parsing ANSI out of every gate's log.

## Consequences

The login stops depending on `python3` being in the agent image, on
`sys.path[0]`, and on a file whose reader has to be polled. A cancel becomes a
signal the container actually receives. A CLI that exits ends the stream, so the
failure modes that produced silence produce an exit code instead.

The cost is a wire format we now own a client for, against a daemon whose SDK
does not expose it — so a protocol change upstream lands here rather than in a
dependency bump. That is why it is one file, and why the frame constants are
named where a diff will show them.

`orch/agent:1` still needs `python3` for other reasons; this ADR does not make
the image smaller.

## Reopen

If the SDK grows a first-party PTY helper — issue 992's second half — this
client should be deleted for it, on the same rule that keeps `run()` in use for
plain commands: rent the transport, own the product.
