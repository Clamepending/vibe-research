#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_VIBE_RESEARCH_HOME="$HOME/.vibe-research"
LEGACY_REMOTE_VIBES_HOME="$HOME/.remote-vibes"
RUNTIME_DIR="${VIBE_RESEARCH_STATE_DIR:-${REMOTE_VIBES_STATE_DIR:-$DEFAULT_VIBE_RESEARCH_HOME}}"
LEGACY_RUNTIME_DIR="$ROOT_DIR/.vibe-research"
LEGACY_REMOTE_VIBES_RUNTIME_DIR="$ROOT_DIR/.remote-vibes"
WIKI_DIR="${VIBE_RESEARCH_WIKI_DIR:-${REMOTE_VIBES_WIKI_DIR:-}}"
CONFIGURED_DEFAULT_SESSION_CWD="${VIBE_RESEARCH_DEFAULT_CWD:-${REMOTE_VIBES_DEFAULT_CWD:-}}"
DEFAULT_WORKSPACE_DIR="${VIBE_RESEARCH_WORKSPACE_DIR:-${REMOTE_VIBES_WORKSPACE_DIR:-}}"
PID_FILE="$RUNTIME_DIR/server.pid"
LOG_FILE="$RUNTIME_DIR/server.log"
NPM_STAMP_FILE="$RUNTIME_DIR/npm-install.stamp"
READY_TIMEOUT_SECONDS="${VIBE_RESEARCH_READY_TIMEOUT_SECONDS:-${REMOTE_VIBES_READY_TIMEOUT_SECONDS:-30}}"
NPM_INSTALL_ATTEMPTS="${VIBE_RESEARCH_NPM_INSTALL_ATTEMPTS:-${REMOTE_VIBES_NPM_INSTALL_ATTEMPTS:-3}}"
NPM_INSTALL_RETRY_DELAY_SECONDS="${VIBE_RESEARCH_NPM_INSTALL_RETRY_DELAY_SECONDS:-${REMOTE_VIBES_NPM_INSTALL_RETRY_DELAY_SECONDS:-5}}"
NPM_FETCH_RETRIES="${VIBE_RESEARCH_NPM_FETCH_RETRIES:-${REMOTE_VIBES_NPM_FETCH_RETRIES:-5}}"
NPM_FETCH_RETRY_FACTOR="${VIBE_RESEARCH_NPM_FETCH_RETRY_FACTOR:-${REMOTE_VIBES_NPM_FETCH_RETRY_FACTOR:-2}}"
NPM_FETCH_RETRY_MINTIMEOUT="${VIBE_RESEARCH_NPM_FETCH_RETRY_MINTIMEOUT:-${REMOTE_VIBES_NPM_FETCH_RETRY_MINTIMEOUT:-20000}}"
NPM_FETCH_RETRY_MAXTIMEOUT="${VIBE_RESEARCH_NPM_FETCH_RETRY_MAXTIMEOUT:-${REMOTE_VIBES_NPM_FETCH_RETRY_MAXTIMEOUT:-120000}}"
NPM_FETCH_TIMEOUT="${VIBE_RESEARCH_NPM_FETCH_TIMEOUT:-${REMOTE_VIBES_NPM_FETCH_TIMEOUT:-300000}}"
NODE_MAJOR="${VIBE_RESEARCH_NODE_MAJOR:-${REMOTE_VIBES_NODE_MAJOR:-22}}"
MIN_NODE_MAJOR=20
AUTO_INSTALL_NODE="${VIBE_RESEARCH_AUTO_INSTALL_NODE:-${REMOTE_VIBES_AUTO_INSTALL_NODE:-1}}"
NODE_INSTALL_ROOT="${VIBE_RESEARCH_NODE_INSTALL_ROOT:-${REMOTE_VIBES_NODE_INSTALL_ROOT:-$HOME/.local/share/vibe-research/node}}"
NODE_BIN_DIR="${VIBE_RESEARCH_NODE_BIN_DIR:-${REMOTE_VIBES_NODE_BIN_DIR:-$HOME/.local/bin}}"
NPM_TARBALL_PREFETCH="${VIBE_RESEARCH_NPM_TARBALL_PREFETCH:-${REMOTE_VIBES_NPM_TARBALL_PREFETCH:-after-failure}}"
NPM_TARBALL_PREFETCH_PACKAGES="${VIBE_RESEARCH_NPM_TARBALL_PREFETCH_PACKAGES:-${REMOTE_VIBES_NPM_TARBALL_PREFETCH_PACKAGES:-node-pty,playwright-core,esbuild}}"
NPM_TARBALL_PREFETCH_RETRIES="${VIBE_RESEARCH_NPM_TARBALL_PREFETCH_RETRIES:-${REMOTE_VIBES_NPM_TARBALL_PREFETCH_RETRIES:-5}}"
NPM_TARBALL_PREFETCH_CONNECT_TIMEOUT="${VIBE_RESEARCH_NPM_TARBALL_PREFETCH_CONNECT_TIMEOUT:-${REMOTE_VIBES_NPM_TARBALL_PREFETCH_CONNECT_TIMEOUT:-30}}"
NPM_TARBALL_PREFETCH_MAX_TIME="${VIBE_RESEARCH_NPM_TARBALL_PREFETCH_MAX_TIME:-${REMOTE_VIBES_NPM_TARBALL_PREFETCH_MAX_TIME:-900}}"
export VIBE_RESEARCH_STATE_DIR="$RUNTIME_DIR"
export REMOTE_VIBES_STATE_DIR="${REMOTE_VIBES_STATE_DIR:-$RUNTIME_DIR}"
if [ -n "$WIKI_DIR" ]; then
  export VIBE_RESEARCH_WIKI_DIR="$WIKI_DIR"
  export REMOTE_VIBES_WIKI_DIR="${REMOTE_VIBES_WIKI_DIR:-$WIKI_DIR}"
fi
cd "$ROOT_DIR"

log() {
  printf '[vibe-research] %s\n' "$*"
}

fail() {
  printf '[vibe-research] %s\n' "$*" >&2
  exit 1
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || return 1
}

node_is_supported() {
  local major
  major="$(node_major_version 2>/dev/null || true)"
  [ -n "$major" ] && [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

prepend_path_dir() {
  local dir="$1"

  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    return
  fi

  case ":$PATH:" in
    *:"$dir":*) ;;
    *)
      PATH="$dir:$PATH"
      export PATH
      ;;
  esac
}

refresh_managed_node_path() {
  prepend_path_dir "$NODE_BIN_DIR"
  prepend_path_dir "$NODE_INSTALL_ROOT/current/bin"
  prepend_path_dir "$HOME/.local/bin"
  prepend_path_dir "/usr/local/bin"
  prepend_path_dir "/opt/homebrew/bin"
  hash -r 2>/dev/null || true
}

ensure_node_runtime() {
  if node_is_supported && command -v npm >/dev/null 2>&1; then
    return
  fi

  refresh_managed_node_path
  if node_is_supported && command -v npm >/dev/null 2>&1; then
    return
  fi

  if [ "$AUTO_INSTALL_NODE" = "0" ]; then
    fail "Missing Node.js >=${MIN_NODE_MAJOR} and npm. Install Node.js ${NODE_MAJOR}.x, then rerun start.sh."
  fi

  if [ ! -f "$ROOT_DIR/install.sh" ]; then
    fail "Missing Node.js >=${MIN_NODE_MAJOR} and npm, and install.sh was not found. Install Node.js ${NODE_MAJOR}.x, then rerun start.sh."
  fi

  log "Node.js >=${MIN_NODE_MAJOR} and npm are required; running the installer Node.js step"
  VIBE_RESEARCH_ENSURE_NODE_ONLY=1 REMOTE_VIBES_ENSURE_NODE_ONLY=1 bash "$ROOT_DIR/install.sh" --ensure-node-only
  refresh_managed_node_path

  if ! node_is_supported; then
    fail "Node.js $(node -v 2>/dev/null || printf 'missing') is not supported. Vibe Research needs Node.js >=${MIN_NODE_MAJOR}."
  fi

  if ! command -v npm >/dev/null 2>&1; then
    fail "npm is missing after Node.js setup."
  fi

  log "Using Node $(node -v) and npm $(npm -v)"
}

expand_home_path() {
  local input="$1"

  case "$input" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${input#~/}"
      ;;
    *)
      printf '%s\n' "$input"
      ;;
  esac
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
  if [ -z "$WIKI_DIR" ]; then
    return
  fi

  if [ "${VIBE_RESEARCH_CREATE_WIKI:-${REMOTE_VIBES_CREATE_WIKI:-1}}" = "0" ]; then
    return
  fi

  mkdir -p "$WIKI_DIR"

  if [ ! -f "$WIKI_DIR/README.md" ]; then
    cat >"$WIKI_DIR/README.md" <<EOF
# mac-brain

Local Library for this Mac.

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
    commit_staged_changes "$WIKI_DIR" "Initialize mac-brain Library"
  fi
}

track_vibe_research_settings() {
  if ! command -v git >/dev/null 2>&1 || [ ! -d "$RUNTIME_DIR/.git" ]; then
    return
  fi

  git_add_existing "$RUNTIME_DIR" README.md .gitignore agent-prompt.md port-aliases.json
  commit_staged_changes "$RUNTIME_DIR" "Track Vibe Research settings"
}

dependency_tree_has_required_packages() {
  if [ ! -d node_modules ]; then
    return 1
  fi

  if [ ! -f node_modules/playwright-core/package.json ]; then
    return 1
  fi

  if [ ! -f node_modules/esbuild/package.json ]; then
    return 1
  fi

  if [ ! -f node_modules/node-pty/package.json ]; then
    return 1
  fi

  return 0
}

dependencies_need_install() {
  if ! dependency_tree_has_required_packages; then
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

  return 1
}

positive_int_or_default() {
  local value="$1"
  local default_value="$2"

  case "$value" in
    ''|*[!0-9]*|0)
      printf '%s\n' "$default_value"
      ;;
    *)
      printf '%s\n' "$value"
      ;;
  esac
}

nonnegative_int_or_default() {
  local value="$1"
  local default_value="$2"

  case "$value" in
    ''|*[!0-9]*)
      printf '%s\n' "$default_value"
      ;;
    *)
      printf '%s\n' "$value"
      ;;
  esac
}

run_npm_dependency_install() {
  local command
  if [ -f package-lock.json ]; then
    command="ci"
  else
    command="install"
  fi

  npm "$command" \
    --prefer-offline \
    --no-audit \
    --no-fund \
    --fetch-retries "$(positive_int_or_default "$NPM_FETCH_RETRIES" 5)" \
    --fetch-retry-factor "$(positive_int_or_default "$NPM_FETCH_RETRY_FACTOR" 2)" \
    --fetch-retry-mintimeout "$(positive_int_or_default "$NPM_FETCH_RETRY_MINTIMEOUT" 20000)" \
    --fetch-retry-maxtimeout "$(positive_int_or_default "$NPM_FETCH_RETRY_MAXTIMEOUT" 120000)" \
    --fetch-timeout "$(positive_int_or_default "$NPM_FETCH_TIMEOUT" 300000)" || return 1

  if ! dependency_tree_has_required_packages; then
    log "Dependency install completed but required packages are missing; retrying"
    return 1
  fi

  return 0
}

esbuild_platform_package_name() {
  local os arch suffix
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"

  case "$os:$arch" in
    Linux:x86_64|Linux:amd64) suffix="linux-x64" ;;
    Linux:aarch64|Linux:arm64) suffix="linux-arm64" ;;
    Linux:armv7l|Linux:armv6l) suffix="linux-arm" ;;
    Darwin:x86_64|Darwin:amd64) suffix="darwin-x64" ;;
    Darwin:arm64|Darwin:aarch64) suffix="darwin-arm64" ;;
    FreeBSD:x86_64|FreeBSD:amd64) suffix="freebsd-x64" ;;
    FreeBSD:aarch64|FreeBSD:arm64) suffix="freebsd-arm64" ;;
    *) suffix="" ;;
  esac

  if [ -n "$suffix" ]; then
    printf '@esbuild/%s\n' "$suffix"
  fi
}

warm_npm_tarball_cache() {
  case "$NPM_TARBALL_PREFETCH" in
    0|false|False|FALSE|off|Off|OFF|never)
      return 1
      ;;
  esac

  if [ ! -f package-lock.json ] || ! command -v curl >/dev/null 2>&1; then
    return 1
  fi

  local prefetch_dir list_file platform_package
  prefetch_dir="$RUNTIME_DIR/npm-tarball-prefetch"
  list_file="$prefetch_dir/tarballs.txt"
  platform_package="$(esbuild_platform_package_name)"

  rm -rf "$prefetch_dir"
  mkdir -p "$prefetch_dir"

  if ! NPM_TARBALL_PREFETCH_PACKAGES="$NPM_TARBALL_PREFETCH_PACKAGES" \
    NPM_PLATFORM_ESBUILD_PACKAGE="$platform_package" \
    node <<'NODE' >"$list_file"; then
const fs = require("fs");

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index === -1) {
    return "";
  }
  return lockPath.slice(index + marker.length);
}

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const configured = String(process.env.NPM_TARBALL_PREFETCH_PACKAGES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const wanted = new Set(configured);
if (process.env.NPM_PLATFORM_ESBUILD_PACKAGE) {
  wanted.add(process.env.NPM_PLATFORM_ESBUILD_PACKAGE);
}

const seen = new Set();
for (const [lockPath, packageInfo] of Object.entries(lock.packages || {})) {
  const name = packageNameFromLockPath(lockPath);
  const resolved = String(packageInfo?.resolved || "");
  if (!name || !resolved.startsWith("https://") || !wanted.has(name) || seen.has(resolved)) {
    continue;
  }
  seen.add(resolved);
  process.stdout.write(`${name} ${resolved}\n`);
}
NODE
    rm -rf "$prefetch_dir"
    return 1
  fi

  if [ ! -s "$list_file" ]; then
    rm -rf "$prefetch_dir"
    return 1
  fi

  log "Warming npm cache for large dependency tarballs"

  local cached_any failed_any name url safe_name file retry_all_errors
  cached_any=0
  failed_any=0
  retry_all_errors=""
  if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    retry_all_errors="--retry-all-errors"
  fi

  while read -r name url; do
    [ -n "$name" ] || continue
    safe_name="$(printf '%s' "$name" | tr '/@' '__' | tr -c 'A-Za-z0-9._-' '_')"
    file="$prefetch_dir/$safe_name.tgz"

    log "Fetching $name tarball with curl"
    if ! curl -fL \
      --retry "$(positive_int_or_default "$NPM_TARBALL_PREFETCH_RETRIES" 5)" \
      $retry_all_errors \
      --connect-timeout "$(positive_int_or_default "$NPM_TARBALL_PREFETCH_CONNECT_TIMEOUT" 30)" \
      --max-time "$(positive_int_or_default "$NPM_TARBALL_PREFETCH_MAX_TIME" 900)" \
      -o "$file" \
      "$url"; then
      log "Could not prefetch $name; npm will retry normally"
      failed_any=1
      continue
    fi

    if npm cache add "$file" --prefer-offline --no-audit --no-fund >/dev/null 2>&1; then
      cached_any=1
    else
      log "Could not add $name tarball to npm cache; npm will retry normally"
      failed_any=1
    fi
  done <"$list_file"

  rm -rf "$prefetch_dir"

  if [ "$cached_any" = "1" ]; then
    return 0
  fi

  [ "$failed_any" = "0" ] || return 1
  return 1
}

ensure_dependencies_installed() {
  ensure_runtime_dir

  if ! dependencies_need_install; then
    return
  fi

  local attempt max_attempts retry_delay prefetch_tried
  max_attempts="$(positive_int_or_default "$NPM_INSTALL_ATTEMPTS" 3)"
  retry_delay="$(nonnegative_int_or_default "$NPM_INSTALL_RETRY_DELAY_SECONDS" 5)"
  prefetch_tried=0

  echo "Installing dependencies..."
  for attempt in $(seq 1 "$max_attempts"); do
    if run_npm_dependency_install; then
      touch "$NPM_STAMP_FILE"
      return
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      fail "Dependency install failed after $max_attempts attempts. Check npm network connectivity, then rerun start.sh."
    fi

    if [ "$prefetch_tried" = "0" ]; then
      warm_npm_tarball_cache || true
      prefetch_tried=1
    fi

    log "Dependency install failed; retrying ($((attempt + 1))/$max_attempts)"
    if [ "$retry_delay" -gt 0 ]; then
      sleep $((attempt * retry_delay))
    fi
  done
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
    # The OS recycled the pid into something unrelated (different node binary,
    # different process entirely). Treat the file as stale rather than aborting
    # the launch — the user has no easy way to recover from a hard fail here.
    log "Pid file pointed at unrelated pid $pid; treating as stale and continuing."
    rm -f "$PID_FILE"
    return
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
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4826}}"

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

resolve_default_session_cwd() {
  if [ -n "$CONFIGURED_DEFAULT_SESSION_CWD" ]; then
    expand_home_path "$CONFIGURED_DEFAULT_SESSION_CWD"
    return
  fi

  if [ -n "$DEFAULT_WORKSPACE_DIR" ]; then
    expand_home_path "$DEFAULT_WORKSPACE_DIR"
    return
  fi

  if [ "$ROOT_DIR" = "$DEFAULT_VIBE_RESEARCH_HOME/app" ] || [ "$ROOT_DIR" = "$LEGACY_REMOTE_VIBES_HOME/app" ]; then
    printf '%s\n' "$HOME/vibe-projects"
    return
  fi

  printf '%s\n' "$ROOT_DIR"
}

ensure_default_session_cwd() {
  local workspace_dir
  local default_cwd

  workspace_dir="$(resolve_default_session_cwd)"
  mkdir -p "$workspace_dir"
  workspace_dir="$(canonicalize_dir "$workspace_dir")"

  export VIBE_RESEARCH_WORKSPACE_DIR="${VIBE_RESEARCH_WORKSPACE_DIR:-$workspace_dir}"
  export REMOTE_VIBES_WORKSPACE_DIR="${REMOTE_VIBES_WORKSPACE_DIR:-$VIBE_RESEARCH_WORKSPACE_DIR}"

  if [ -n "$CONFIGURED_DEFAULT_SESSION_CWD" ]; then
    default_cwd="$(expand_home_path "$CONFIGURED_DEFAULT_SESSION_CWD")"
    mkdir -p "$default_cwd"
    default_cwd="$(canonicalize_dir "$default_cwd")"
    export VIBE_RESEARCH_DEFAULT_CWD="$default_cwd"
    export REMOTE_VIBES_DEFAULT_CWD="${REMOTE_VIBES_DEFAULT_CWD:-$default_cwd}"
  fi
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
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4826}}"

  fail "Port $port is already serving Vibe Research from $workspace_cwd. Stop that server or relaunch with VIBE_RESEARCH_PORT=<free-port>."
}

terminate_running_vibe_research() {
  local port
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4826}}"

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
if [ -n "$WIKI_DIR" ]; then
  WIKI_DIR="$(expand_home_path "$WIKI_DIR")"
  export VIBE_RESEARCH_WIKI_DIR="$WIKI_DIR"
  export REMOTE_VIBES_WIKI_DIR="${REMOTE_VIBES_WIKI_DIR:-$WIKI_DIR}"
fi
migrate_legacy_runtime_dir
migrate_home_checkout_to_app
ensure_node_runtime
ensure_vibe_research_settings_repo
ensure_mac_brain_wiki
ensure_default_session_cwd

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

track_vibe_research_settings
log "Background server pid: $server_pid"
log "Server is detached and will keep running after this terminal closes."
log "State directory: $RUNTIME_DIR"
log "Workspace directory: ${VIBE_RESEARCH_WORKSPACE_DIR:-$DEFAULT_WORKSPACE_DIR}"
if [ -n "$WIKI_DIR" ]; then
  log "Library directory: $WIKI_DIR"
else
  log "Library directory: ${VIBE_RESEARCH_WORKSPACE_DIR:-$DEFAULT_WORKSPACE_DIR}/vibe-research/buildings/library"
fi
print_startup_log
