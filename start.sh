#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_VIBE_RESEARCH_HOME="$HOME/.vibe-research"
LEGACY_REMOTE_VIBES_HOME="$HOME/.remote-vibes"
RUNTIME_DIR="${VIBE_RESEARCH_STATE_DIR:-${REMOTE_VIBES_STATE_DIR:-$DEFAULT_VIBE_RESEARCH_HOME}}"
LEGACY_RUNTIME_DIR="$ROOT_DIR/.vibe-research"
LEGACY_REMOTE_VIBES_RUNTIME_DIR="$ROOT_DIR/.remote-vibes"
WIKI_DIR="${VIBE_RESEARCH_WIKI_DIR:-${REMOTE_VIBES_WIKI_DIR:-$HOME/mac-brain}}"
PID_FILE="$RUNTIME_DIR/server.pid"
LOG_FILE="$RUNTIME_DIR/server.log"
NPM_STAMP_FILE="$RUNTIME_DIR/npm-install.stamp"
READY_TIMEOUT_SECONDS="${VIBE_RESEARCH_READY_TIMEOUT_SECONDS:-${REMOTE_VIBES_READY_TIMEOUT_SECONDS:-30}}"
export VIBE_RESEARCH_STATE_DIR="$RUNTIME_DIR"
export REMOTE_VIBES_STATE_DIR="${REMOTE_VIBES_STATE_DIR:-$RUNTIME_DIR}"
cd "$ROOT_DIR"

log() {
  printf '[vibe-research] %s\n' "$*"
}

fail() {
  printf '[vibe-research] %s\n' "$*" >&2
  exit 1
}

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

copy_file_if_missing() {
  local source="$1"
  local target="$2"

  if [ -e "$source" ] && [ ! -e "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp -p "$source" "$target"
  fi
}

copy_dir_if_missing() {
  local source="$1"
  local target="$2"

  if [ -d "$source" ] && [ ! -e "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp -pR "$source" "$target"
  fi
}

copy_runtime_state_from_dir() {
  local source_dir="$1"

  if [ "$source_dir" = "$RUNTIME_DIR" ] || [ ! -d "$source_dir" ]; then
    return
  fi

  ensure_runtime_dir

  copy_file_if_missing "$source_dir/sessions.json" "$RUNTIME_DIR/sessions.json"
  copy_file_if_missing "$source_dir/port-aliases.json" "$RUNTIME_DIR/port-aliases.json"
  copy_file_if_missing "$source_dir/agent-prompt.md" "$RUNTIME_DIR/agent-prompt.md"
  copy_file_if_missing "$source_dir/server.pid" "$RUNTIME_DIR/server.pid"
  copy_file_if_missing "$source_dir/server.log" "$RUNTIME_DIR/server.log"
  copy_file_if_missing "$source_dir/npm-install.stamp" "$RUNTIME_DIR/npm-install.stamp"
  copy_dir_if_missing "$source_dir/browser" "$RUNTIME_DIR/browser"
  copy_dir_if_missing "$source_dir/session-name-requests" "$RUNTIME_DIR/session-name-requests"
}

migrate_legacy_runtime_dir() {
  if [ "$RUNTIME_DIR" = "$DEFAULT_VIBE_RESEARCH_HOME" ]; then
    copy_runtime_state_from_dir "$DEFAULT_VIBE_RESEARCH_HOME/state"
    copy_runtime_state_from_dir "$DEFAULT_VIBE_RESEARCH_HOME/.vibe-research"
    copy_runtime_state_from_dir "$LEGACY_REMOTE_VIBES_HOME"
    copy_runtime_state_from_dir "$LEGACY_REMOTE_VIBES_HOME/state"
    copy_runtime_state_from_dir "$LEGACY_REMOTE_VIBES_HOME/.remote-vibes"
    copy_runtime_state_from_dir "$LEGACY_REMOTE_VIBES_HOME/app/.remote-vibes"
  fi

  copy_runtime_state_from_dir "$LEGACY_RUNTIME_DIR"
  copy_runtime_state_from_dir "$LEGACY_REMOTE_VIBES_RUNTIME_DIR"
}

looks_like_vibe_research_checkout() {
  local target_dir="$1"

  [ -f "$target_dir/package.json" ] && [ -f "$target_dir/start.sh" ] && [ -f "$target_dir/src/server.js" ]
}

move_checkout_contents_to_app() {
  local source_dir="$1"
  local app_dir="$2"
  local label="$3"

  log "Moving old $label checkout from $source_dir to $app_dir"
  mkdir -p "$app_dir"

  local entry base
  for entry in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$entry" ] || continue

    base="$(basename "$entry")"
    case "$base" in
      .|..|app|state|sessions.json|sessions.json.tmp|port-aliases.json|port-aliases.json.tmp|agent-prompt.md|agent-prompt.md.tmp|server.pid|server.log|npm-install.stamp|browser|session-name-requests)
        continue
        ;;
    esac

    if [ -e "$app_dir/$base" ]; then
      log "Leaving $entry in place because $app_dir/$base already exists"
      continue
    fi

    mv "$entry" "$app_dir/$base"
  done
}

migrate_home_checkout_to_app() {
  if [ "${VIBE_RESEARCH_SKIP_HOME_CHECKOUT_MIGRATION:-${REMOTE_VIBES_SKIP_HOME_CHECKOUT_MIGRATION:-0}}" = "1" ]; then
    return
  fi

  if [ "$RUNTIME_DIR" != "$DEFAULT_VIBE_RESEARCH_HOME" ] || [ "$DEFAULT_VIBE_RESEARCH_HOME" = "$ROOT_DIR" ]; then
    return
  fi

  local app_dir
  app_dir="$DEFAULT_VIBE_RESEARCH_HOME/app"

  if looks_like_vibe_research_checkout "$app_dir"; then
    return
  fi

  if looks_like_vibe_research_checkout "$DEFAULT_VIBE_RESEARCH_HOME"; then
    move_checkout_contents_to_app "$DEFAULT_VIBE_RESEARCH_HOME" "$app_dir" "Vibe Research"
    return
  fi

  if [ "$LEGACY_REMOTE_VIBES_HOME" != "$ROOT_DIR" ] && looks_like_vibe_research_checkout "$LEGACY_REMOTE_VIBES_HOME"; then
    move_checkout_contents_to_app "$LEGACY_REMOTE_VIBES_HOME" "$app_dir" "Remote Vibes"
  fi
}

ensure_gitignore_entry() {
  local gitignore_file="$1"
  local entry="$2"

  if ! grep -Fxq "$entry" "$gitignore_file" 2>/dev/null; then
    printf '%s\n' "$entry" >>"$gitignore_file"
  fi
}

ensure_git_repo() {
  local target_dir="$1"

  if ! command -v git >/dev/null 2>&1; then
    return
  fi

  if [ ! -d "$target_dir/.git" ]; then
    git -C "$target_dir" init >/dev/null 2>&1 || return
  fi
}

ensure_git_identity() {
  local target_dir="$1"

  if ! command -v git >/dev/null 2>&1 || [ ! -d "$target_dir/.git" ]; then
    return
  fi

  git -C "$target_dir" config user.name >/dev/null 2>&1 || git -C "$target_dir" config user.name "Vibe Research"
  git -C "$target_dir" config user.email >/dev/null 2>&1 || git -C "$target_dir" config user.email "vibe-research@local"
}

commit_staged_changes() {
  local target_dir="$1"
  local message="$2"

  if ! command -v git >/dev/null 2>&1 || [ ! -d "$target_dir/.git" ]; then
    return
  fi

  if git -C "$target_dir" diff --cached --quiet >/dev/null 2>&1; then
    return
  fi

  ensure_git_identity "$target_dir"
  git -C "$target_dir" commit -m "$message" >/dev/null 2>&1 || true
}

git_add_existing() {
  local target_dir="$1"
  shift

  if ! command -v git >/dev/null 2>&1 || [ ! -d "$target_dir/.git" ]; then
    return
  fi

  local entry
  for entry in "$@"; do
    if [ -e "$target_dir/$entry" ]; then
      git -C "$target_dir" add "$entry" >/dev/null 2>&1 || true
    fi
  done
}

ensure_vibe_research_settings_repo() {
  ensure_runtime_dir

  if [ ! -f "$RUNTIME_DIR/README.md" ]; then
    cat >"$RUNTIME_DIR/README.md" <<EOF
# Vibe Research State

This directory stores local Vibe Research settings for this Mac.

Tracked settings include:
- agent-prompt.md
- port-aliases.json

Runtime files such as sessions.json, server logs, pid files, and browser captures are intentionally ignored because they may contain transcripts, secrets, or large generated artifacts.
EOF
  fi

  if [ ! -f "$RUNTIME_DIR/.gitignore" ]; then
    cat >"$RUNTIME_DIR/.gitignore" <<'EOF'
EOF
  fi

  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "app/"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "state/"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "server.pid"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "server.log"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "npm-install.stamp"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "sessions.json"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "sessions.json.tmp"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "browser/"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "session-name-requests/"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" "*.tmp"
  ensure_gitignore_entry "$RUNTIME_DIR/.gitignore" ".DS_Store"

  ensure_git_repo "$RUNTIME_DIR"

  if command -v git >/dev/null 2>&1 && [ -d "$RUNTIME_DIR/.git" ]; then
    git_add_existing "$RUNTIME_DIR" README.md .gitignore agent-prompt.md port-aliases.json
    commit_staged_changes "$RUNTIME_DIR" "Track Vibe Research settings"
  fi
}

ensure_mac_brain_wiki() {
  if [ "${VIBE_RESEARCH_CREATE_WIKI:-${REMOTE_VIBES_CREATE_WIKI:-1}}" = "0" ]; then
    return
  fi

  mkdir -p "$WIKI_DIR"

  if [ ! -f "$WIKI_DIR/README.md" ]; then
    cat >"$WIKI_DIR/README.md" <<EOF
# mac-brain

Local wiki for this Mac.

Vibe Research settings live in:

\`\`\`
$RUNTIME_DIR
\`\`\`
EOF
  fi

  if [ ! -f "$WIKI_DIR/.gitignore" ]; then
    cat >"$WIKI_DIR/.gitignore" <<'EOF'
.DS_Store
EOF
  fi

  ensure_git_repo "$WIKI_DIR"

  if command -v git >/dev/null 2>&1 && [ -d "$WIKI_DIR/.git" ]; then
    git_add_existing "$WIKI_DIR" README.md .gitignore
    commit_staged_changes "$WIKI_DIR" "Initialize mac-brain wiki"
  fi
}

track_vibe_research_settings() {
  if ! command -v git >/dev/null 2>&1 || [ ! -d "$RUNTIME_DIR/.git" ]; then
    return
  fi

  git_add_existing "$RUNTIME_DIR" README.md .gitignore agent-prompt.md port-aliases.json
  commit_staged_changes "$RUNTIME_DIR" "Track Vibe Research settings"
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
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
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

looks_like_vibe_research_server() {
  local pid="$1"
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"node src/server.js"*) return 0 ;;
    *"vibe-research"*"/src/server.js"*) return 0 ;;
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

  if ! looks_like_vibe_research_server "$pid"; then
    fail "Refusing to stop pid $pid because it does not look like a managed Vibe Research server."
  fi

  log "Stopping existing Vibe Research server (pid $pid)"
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
  host="${VIBE_RESEARCH_HOST:-${REMOTE_VIBES_HOST:-0.0.0.0}}"
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4123}}"

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

terminate_url() {
  local url
  url="$(healthcheck_url)"
  printf '%s/api/terminate\n' "${url%/api/state}"
}

canonicalize_dir() {
  local dir="$1"

  if [ -d "$dir" ]; then
    (cd "$dir" && pwd -P)
    return
  fi

  printf '%s\n' "$dir"
}

healthcheck_payload() {
  curl -fsS "$(healthcheck_url)" 2>/dev/null
}

probe_running_vibe_research_workspace() {
  local payload

  if ! payload="$(healthcheck_payload)"; then
    return 1
  fi

  printf '%s' "$payload" | node -e '
let source = "";
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(source);

    if (
      (payload?.appName === "Vibe Research" || payload?.appName === "Remote Vibes") &&
      typeof payload.cwd === "string" &&
      payload.cwd
    ) {
      process.stdout.write(payload.cwd);
      return;
    }

    process.exit(1);
  } catch {
    process.exit(1);
  }
});
'
}

probe_running_vibe_research_state_dir() {
  local payload

  if ! payload="$(healthcheck_payload)"; then
    return 1
  fi

  printf '%s' "$payload" | node -e '
let source = "";
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(source);

    if (
      (payload?.appName === "Vibe Research" || payload?.appName === "Remote Vibes") &&
      typeof payload.stateDir === "string" &&
      payload.stateDir
    ) {
      process.stdout.write(payload.stateDir);
      return;
    }

    process.exit(1);
  } catch {
    process.exit(1);
  }
});
'
}

fail_for_foreign_workspace() {
  local workspace_cwd="$1"
  local port
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4123}}"

  fail "Port $port is already serving Vibe Research from $workspace_cwd. Stop that server or relaunch with VIBE_RESEARCH_PORT=<free-port>."
}

terminate_running_vibe_research() {
  local port
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4123}}"

  log "Stopping existing Vibe Research server on port $port"
  curl -fsS -X POST "$(terminate_url)" >/dev/null 2>&1 || true

  local attempt
  for attempt in $(seq 1 50); do
    if ! healthcheck_payload >/dev/null; then
      return
    fi
    sleep 0.2
  done

  fail "Existing Vibe Research server on port $port did not stop in time."
}

wait_for_server_ready() {
  local pid="$1"
  local workspace_cwd canonical_workspace_cwd

  local attempt max_attempts
  max_attempts=$((READY_TIMEOUT_SECONDS * 5))

  for attempt in $(seq 1 "$max_attempts"); do
    if ! is_pid_running "$pid"; then
      return 1
    fi

    if workspace_cwd="$(probe_running_vibe_research_workspace)"; then
      canonical_workspace_cwd="$(canonicalize_dir "$workspace_cwd")"
      if [ "$canonical_workspace_cwd" = "$ROOT_DIR" ]; then
        return 0
      fi
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
import signal
import subprocess

def detach_from_terminal():
    os.setsid()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

with open(os.environ["LOG_FILE"], "ab", buffering=0) as log_handle:
    process = subprocess.Popen(
        ["node", "src/server.js"],
        cwd=os.environ["ROOT_DIR"],
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        preexec_fn=detach_from_terminal,
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

ensure_runtime_dir
migrate_legacy_runtime_dir
migrate_home_checkout_to_app
ensure_vibe_research_settings_repo
ensure_mac_brain_wiki

if workspace_cwd="$(probe_running_vibe_research_workspace)"; then
  canonical_workspace_cwd="$(canonicalize_dir "$workspace_cwd")"
  if [ "$canonical_workspace_cwd" = "$ROOT_DIR" ]; then
    running_state_dir="$(probe_running_vibe_research_state_dir || true)"

    if [ "$running_state_dir" = "$RUNTIME_DIR" ] && [ "${VIBE_RESEARCH_FORCE_RESTART:-${REMOTE_VIBES_FORCE_RESTART:-0}}" != "1" ]; then
      log "Vibe Research is already running for this workspace at $(healthcheck_url)"
      exit 0
    fi

    if [ -n "$running_state_dir" ]; then
      log "Vibe Research is running for this workspace with state $running_state_dir; relaunching with $RUNTIME_DIR"
    else
      log "Vibe Research is running for this workspace; relaunching with state $RUNTIME_DIR"
    fi

    terminate_running_vibe_research
  else
    fail_for_foreign_workspace "$workspace_cwd"
  fi
fi

stop_existing_server

ensure_dependencies_installed
node scripts/build-client.mjs

server_pid="$(start_server_in_background)"

if ! wait_for_server_ready "$server_pid"; then
  workspace_cwd="$(probe_running_vibe_research_workspace || true)"
  print_startup_log >&2
  rm -f "$PID_FILE"

  if [ -n "$workspace_cwd" ] && [ "$(canonicalize_dir "$workspace_cwd")" != "$ROOT_DIR" ]; then
    fail_for_foreign_workspace "$workspace_cwd"
  fi

  fail "Vibe Research failed to start within ${READY_TIMEOUT_SECONDS}s."
fi

print_startup_log
track_vibe_research_settings
log "Background server pid: $server_pid"
log "Server is detached and will keep running after this terminal closes."
log "State directory: $RUNTIME_DIR"
log "Wiki directory: $WIKI_DIR"
