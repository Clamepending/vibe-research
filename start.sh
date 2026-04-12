#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.remote-vibes"
PID_FILE="$RUNTIME_DIR/server.pid"
LOG_FILE="$RUNTIME_DIR/server.log"
NPM_STAMP_FILE="$RUNTIME_DIR/npm-install.stamp"
READY_TIMEOUT_SECONDS="${REMOTE_VIBES_READY_TIMEOUT_SECONDS:-30}"
cd "$ROOT_DIR"

log() {
  printf '[remote-vibes] %s\n' "$*"
}

fail() {
  printf '[remote-vibes] %s\n' "$*" >&2
  exit 1
}

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

dependencies_need_install() {
  if [ ! -d node_modules ]; then
    return 0
  fi

  if [ ! -f "$NPM_STAMP_FILE" ]; then
    return 0
  fi

  if [ package.json -nt "$NPM_STAMP_FILE" ]; then
    return 0
  fi

  if [ package-lock.json -nt "$NPM_STAMP_FILE" ]; then
    return 0
  fi

  if [ ! -f node_modules/playwright-core/package.json ]; then
    return 0
  fi

  return 1
}

ensure_dependencies_installed() {
  ensure_runtime_dir

  if ! dependencies_need_install; then
    return
  fi

  echo "Installing dependencies..."
  npm install
  touch "$NPM_STAMP_FILE"
}

read_pid_file() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  local pid
  pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi

  printf '%s\n' "$pid"
}

is_pid_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

looks_like_remote_vibes_server() {
  local pid="$1"
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"node src/server.js"*) return 0 ;;
    *"remote-vibes"*"/src/server.js"*) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup_stale_pid_file() {
  local pid
  if ! pid="$(read_pid_file)"; then
    rm -f "$PID_FILE"
    return
  fi

  if ! is_pid_running "$pid"; then
    rm -f "$PID_FILE"
  fi
}

stop_existing_server() {
  local pid

  cleanup_stale_pid_file
  if ! pid="$(read_pid_file)"; then
    return
  fi

  if ! is_pid_running "$pid"; then
    rm -f "$PID_FILE"
    return
  fi

  if ! looks_like_remote_vibes_server "$pid"; then
    fail "Refusing to stop pid $pid because it does not look like a managed Remote Vibes server."
  fi

  log "Stopping existing Remote Vibes server (pid $pid)"
  kill "$pid" >/dev/null 2>&1 || true

  local attempt
  for attempt in $(seq 1 50); do
    if ! is_pid_running "$pid"; then
      rm -f "$PID_FILE"
      return
    fi
    sleep 0.2
  done

  log "Existing server did not stop in time, sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
}

healthcheck_url() {
  local host port probe_host
  host="${REMOTE_VIBES_HOST:-0.0.0.0}"
  port="${REMOTE_VIBES_PORT:-4123}"

  case "$host" in
    0.0.0.0|'')
      probe_host="127.0.0.1"
      ;;
    ::|::0|[::]|localhost)
      probe_host="127.0.0.1"
      ;;
    *)
      probe_host="$host"
      ;;
  esac

  printf 'http://%s:%s/api/state\n' "$probe_host" "$port"
}

wait_for_server_ready() {
  local pid="$1"
  local url
  url="$(healthcheck_url)"

  local attempt max_attempts
  max_attempts=$((READY_TIMEOUT_SECONDS * 5))

  for attempt in $(seq 1 "$max_attempts"); do
    if ! is_pid_running "$pid"; then
      return 1
    fi

    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.2
  done

  return 1
}

start_server_in_background() {
  ensure_runtime_dir
  : >"$LOG_FILE"

  local pid

  if command -v python3 >/dev/null 2>&1; then
    pid="$(
      ROOT_DIR="$ROOT_DIR" LOG_FILE="$LOG_FILE" python3 <<'PY'
import os
import subprocess

with open(os.environ["LOG_FILE"], "ab", buffering=0) as log_handle:
    process = subprocess.Popen(
        ["node", "src/server.js"],
        cwd=os.environ["ROOT_DIR"],
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )

print(process.pid)
PY
    )"
  elif command -v setsid >/dev/null 2>&1; then
    nohup setsid node src/server.js >>"$LOG_FILE" 2>&1 </dev/null &
    pid=$!
  else
    nohup node src/server.js >>"$LOG_FILE" 2>&1 </dev/null &
    pid=$!
  fi

  printf '%s\n' "$pid" >"$PID_FILE"
  printf '%s\n' "$pid"
}

print_startup_log() {
  if [ -f "$LOG_FILE" ]; then
    cat "$LOG_FILE"
  fi
}

ensure_dependencies_installed
node scripts/build-client.mjs
ensure_runtime_dir
stop_existing_server

server_pid="$(start_server_in_background)"

if ! wait_for_server_ready "$server_pid"; then
  print_startup_log >&2
  rm -f "$PID_FILE"
  fail "Remote Vibes failed to start within ${READY_TIMEOUT_SECONDS}s."
fi

print_startup_log
log "Background server pid: $server_pid"
