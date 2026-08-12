#!/usr/bin/env bash
# Live re-run of the sandbox matrix behind docs/decisions/001.
#
# Not part of `bun test`: it spends real tokens and takes a few minutes. Run it
# when Claude Code's sandbox implementation changes, or when a clearance profile
# stops behaving. Uses haiku and throwaway directories.
#
#   ./test/sandbox-probe.sh
#
# Expected outcome (as of Claude Code 2.1.228):
#   write inside cwd        allowed
#   write outside cwd       allowed unless denyWrite lists it   <- the surprise
#   read a denyRead path    blocked
#   allowWrite override     ignored (deny wins)
#   localhost TCP           blocked, unless network.allowLocalBinding
#   unix socket             blocked, unless allowAllUnixSockets (which also
#                           opens /var/run/docker.sock)
set -uo pipefail

MODEL=${MODEL:-claude-haiku-4-5-20251001}
D=$(mktemp -d "${TMPDIR:-/tmp}/orch-sbx.XXXXXX")
PORT=${PORT:-47824}
trap 'kill %1 2>/dev/null; rm -rf "$D"' EXIT

mkdir -p "$D/wt" "$D/locked"
echo "SECRET=hunter2" > "$D/secret.env"

cat > "$D/srv.ts" <<'TS'
Bun.serve({ hostname: "127.0.0.1", port: Number(process.argv[2]), fetch: () => new Response("PONG-TCP") });
TS
bun run "$D/srv.ts" "$PORT" & sleep 0.8

probe() { # name, settings-json, prompt
  printf '\n########## %s ##########\n' "$1"
  printf '%s' "$2" > "$D/s.json"
  printf '%s' "$3" | (cd "$D/wt" && claude -p --output-format stream-json --verbose \
    --model "$MODEL" --max-turns 8 --settings "$D/s.json" \
    --permission-mode acceptEdits --allowedTools "Bash" 2>&1) > "$D/out.jsonl"
  jq -r 'select(.type=="user")|(.tool_use_result|tostring)' "$D/out.jsonl" | head -6
}

probe "writes: default confines nothing" \
  "{\"sandbox\":{\"enabled\":true,\"failIfUnavailable\":true,\"autoAllowBashIfSandboxed\":true,\"filesystem\":{\"denyRead\":[\"$D/secret.env\"]}}}" \
  "$(printf 'Diagnosing a sandbox config. Run each as a SEPARATE Bash call, report exit code and output, keep going on failure:\n1) echo A > inside.txt\n2) echo B > %s/outside.txt\n3) cat %s/secret.env\n' "$D" "$D")"
echo "--- outside.txt exists? (expected: yes, which is why denyWrite is mandatory)"; ls "$D/outside.txt" 2>&1

probe "allowWrite cannot override denyWrite" \
  "{\"sandbox\":{\"enabled\":true,\"failIfUnavailable\":true,\"autoAllowBashIfSandboxed\":true,\"filesystem\":{\"denyWrite\":[\"$D/locked/**\"],\"allowWrite\":[\"$D/locked/ok/**\"]}}}" \
  "$(printf 'Diagnosing a sandbox config. Run with Bash: mkdir -p %s/locked/ok && echo A > %s/locked/ok/a.txt\nReport exit code and error text.\n' "$D" "$D")"

probe "localhost TCP needs allowLocalBinding" \
  '{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"network":{"allowAllUnixSockets":false}}}' \
  "$(printf 'Diagnosing a sandbox config. Run with Bash: curl -s --max-time 4 http://127.0.0.1:%s/\nReport exit code and output.\n' "$PORT")"

probe "localhost TCP with allowLocalBinding" \
  '{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"network":{"allowAllUnixSockets":false,"allowLocalBinding":true}}}' \
  "$(printf 'Diagnosing a sandbox config. Run with Bash: curl -s --max-time 4 http://127.0.0.1:%s/\nReport exit code and output.\n' "$PORT")"

probe "excludedCommands unsandboxes the whole command line" \
  "{\"sandbox\":{\"enabled\":true,\"failIfUnavailable\":true,\"autoAllowBashIfSandboxed\":true,\"excludedCommands\":[\"true\"],\"filesystem\":{\"denyWrite\":[\"$D/locked/**\"]}}}" \
  "$(printf 'Diagnosing a sandbox config. Run each as a SEPARATE Bash call, report exit code and error text, keep going on failure:\n1) echo A > %s/locked/a.txt\n2) true && echo B > %s/locked/b.txt\n' "$D" "$D")"
echo "--- locked/b.txt exists? (expected: yes — this is why excludedCommands is unusable)"; ls "$D/locked/b.txt" 2>&1
