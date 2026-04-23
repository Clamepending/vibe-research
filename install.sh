#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${VIBE_RESEARCH_REPO_SLUG:-${REMOTE_VIBES_REPO_SLUG:-Clamepending/vibe-research}}"
INSTALL_DIR="${VIBE_RESEARCH_HOME:-${REMOTE_VIBES_HOME:-$HOME/.vibe-research/app}}"
if [ -n "${VIBE_RESEARCH_REF+x}" ] || [ -n "${REMOTE_VIBES_REF+x}" ]; then
  REPO_REF_WAS_SET=1
else
  REPO_REF_WAS_SET=0
fi
REPO_REF="${VIBE_RESEARCH_REF:-${REMOTE_VIBES_REF:-main}}"
REPO_URL="${VIBE_RESEARCH_REPO_URL:-${REMOTE_VIBES_REPO_URL:-}}"
UPDATE_CHANNEL="${VIBE_RESEARCH_UPDATE_CHANNEL:-${REMOTE_VIBES_UPDATE_CHANNEL:-release}}"
SKIP_RUN="${VIBE_RESEARCH_SKIP_RUN:-${REMOTE_VIBES_SKIP_RUN:-0}}"
INSTALL_SYSTEM_DEPS="${VIBE_RESEARCH_INSTALL_SYSTEM_DEPS:-${REMOTE_VIBES_INSTALL_SYSTEM_DEPS:-1}}"
INSTALL_TAILSCALE="${VIBE_RESEARCH_INSTALL_TAILSCALE:-${REMOTE_VIBES_INSTALL_TAILSCALE:-auto}}"
INSTALL_CLAUDE_CODE="${VIBE_RESEARCH_INSTALL_CLAUDE_CODE:-${REMOTE_VIBES_INSTALL_CLAUDE_CODE:-auto}}"
CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS="${VIBE_RESEARCH_CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS:-${REMOTE_VIBES_CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS:-600}}"
INSTALL_UI="${VIBE_RESEARCH_INSTALL_UI:-${REMOTE_VIBES_INSTALL_UI:-auto}}"
INSTALL_ANIMATION="${VIBE_RESEARCH_INSTALL_ANIMATION:-${REMOTE_VIBES_INSTALL_ANIMATION:-auto}}"
INSTALL_SERVICE="${VIBE_RESEARCH_INSTALL_SERVICE:-${REMOTE_VIBES_INSTALL_SERVICE:-1}}"
ENSURE_NODE_ONLY="${VIBE_RESEARCH_ENSURE_NODE_ONLY:-${REMOTE_VIBES_ENSURE_NODE_ONLY:-0}}"
USER_BIN_DIR="${VIBE_RESEARCH_BIN_DIR:-${REMOTE_VIBES_BIN_DIR:-}}"
TAILSCALE_UP="${VIBE_RESEARCH_TAILSCALE_UP:-${REMOTE_VIBES_TAILSCALE_UP:-1}}"
TAILSCALE_COMMAND="${VIBE_RESEARCH_TAILSCALE_COMMAND:-${REMOTE_VIBES_TAILSCALE_COMMAND:-tailscale}}"
CLAUDE_COMMAND="${VIBE_RESEARCH_CLAUDE_COMMAND:-${REMOTE_VIBES_CLAUDE_COMMAND:-claude}}"
TAILSCALE_AUTHKEY="${VIBE_RESEARCH_TAILSCALE_AUTHKEY:-${REMOTE_VIBES_TAILSCALE_AUTHKEY:-}}"
TAILSCALE_USE_SUDO="${VIBE_RESEARCH_TAILSCALE_USE_SUDO:-${REMOTE_VIBES_TAILSCALE_USE_SUDO:-1}}"
TAILSCALE_DAEMON_WAIT_SECONDS="${VIBE_RESEARCH_TAILSCALE_DAEMON_WAIT_SECONDS:-${REMOTE_VIBES_TAILSCALE_DAEMON_WAIT_SECONDS:-15}}"
TAILSCALED_LOG_FILE="${VIBE_RESEARCH_TAILSCALED_LOG_FILE:-${REMOTE_VIBES_TAILSCALED_LOG_FILE:-/tmp/vibe-research-tailscaled.log}}"
SERVICE_NAME="${VIBE_RESEARCH_SERVICE_NAME:-${REMOTE_VIBES_SERVICE_NAME:-vibe-research}}"
SYSTEMD_SERVICE_DIR="${VIBE_RESEARCH_SYSTEMD_SERVICE_DIR:-${REMOTE_VIBES_SYSTEMD_SERVICE_DIR:-/etc/systemd/system}}"
NODE_MAJOR="${VIBE_RESEARCH_NODE_MAJOR:-${REMOTE_VIBES_NODE_MAJOR:-22}}"
MIN_NODE_MAJOR=20
NODE_INSTALL_ROOT="${VIBE_RESEARCH_NODE_INSTALL_ROOT:-${REMOTE_VIBES_NODE_INSTALL_ROOT:-$HOME/.local/share/vibe-research/node}}"
NODE_BIN_DIR="${VIBE_RESEARCH_NODE_BIN_DIR:-${REMOTE_VIBES_NODE_BIN_DIR:-$HOME/.local/bin}}"
APT_UPDATED=0
MANAGED_PROMPT_MARKER="<!-- vibe-research:managed-agent-prompt -->"
LEGACY_MANAGED_PROMPT_MARKER="<!-- remote-vibes:managed-agent-prompt -->"
INSTALL_STEP=0
INSTALL_TOTAL_STEPS=10
INSTALL_SPINNER_PID=""
INSTALL_RESET=""
INSTALL_BOLD=""
INSTALL_DIM=""
INSTALL_BLUE=""
INSTALL_CYAN=""
INSTALL_GREEN=""
INSTALL_RED=""
INSTALL_YELLOW=""

case "${1:-}" in
  --ensure-node-only)
    ENSURE_NODE_ONLY=1
    shift
    ;;
esac

terminal_ui_enabled() {
  case "$INSTALL_UI" in
    plain | off | 0 | false | no)
      return 1
      ;;
    fancy | pretty | on | 1 | true | yes)
      return 0
      ;;
  esac

  [ -t 1 ] && [ "${TERM:-}" != "dumb" ]
}

terminal_animation_enabled() {
  terminal_ui_enabled || return 1

  case "$INSTALL_ANIMATION" in
    off | 0 | false | no)
      return 1
      ;;
    on | 1 | true | yes)
      return 0
      ;;
  esac

  [ -t 1 ] && [ "${TERM:-}" != "dumb" ]
}

terminal_color_enabled() {
  terminal_ui_enabled || return 1
  [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]
}

init_terminal_ui() {
  if ! terminal_color_enabled; then
    return
  fi

  INSTALL_RESET="$(printf '\033[0m')"
  INSTALL_BOLD="$(printf '\033[1m')"
  INSTALL_DIM="$(printf '\033[2m')"
  INSTALL_BLUE="$(printf '\033[34m')"
  INSTALL_CYAN="$(printf '\033[36m')"
  INSTALL_GREEN="$(printf '\033[32m')"
  INSTALL_RED="$(printf '\033[31m')"
  INSTALL_YELLOW="$(printf '\033[33m')"
}

spinner_frame() {
  case "$1" in
    0) printf '|' ;;
    1) printf '/' ;;
    2) printf '-' ;;
    *) printf '\\' ;;
  esac
}

spinner_loop() {
  local label frame_index frame
  label="$1"
  frame_index=0

  while :; do
    frame="$(spinner_frame "$frame_index")"
    printf '\r\033[K%s%s%s %s%s%s' "$INSTALL_CYAN" "$frame" "$INSTALL_RESET" "$INSTALL_DIM" "$label" "$INSTALL_RESET"
    frame_index=$(((frame_index + 1) % 4))
    sleep 0.12
  done
}

stop_spinner() {
  if [ -z "$INSTALL_SPINNER_PID" ]; then
    return
  fi

  kill "$INSTALL_SPINNER_PID" >/dev/null 2>&1 || true
  wait "$INSTALL_SPINNER_PID" 2>/dev/null || true
  INSTALL_SPINNER_PID=""
  printf '\r\033[K'
}

start_spinner() {
  local label
  label="$1"

  stop_spinner
  if terminal_animation_enabled; then
    spinner_loop "$label" &
    INSTALL_SPINNER_PID=$!
  elif terminal_ui_enabled; then
    printf '%s..%s %s\n' "$INSTALL_DIM" "$INSTALL_RESET" "$label"
  fi
}

print_installer_banner() {
  local repo_url

  terminal_ui_enabled || return 0
  repo_url="$(resolve_repo_url)"

  printf '\n%s%sVibe Research%s\n' "$INSTALL_BOLD" "$INSTALL_BLUE" "$INSTALL_RESET"
  printf '%sInstaller for local agent workspaces%s\n' "$INSTALL_DIM" "$INSTALL_RESET"
  printf '%srepo%s   %s\n' "$INSTALL_DIM" "$INSTALL_RESET" "$repo_url"
  printf '%starget%s %s\n\n' "$INSTALL_DIM" "$INSTALL_RESET" "$INSTALL_DIR"
}

print_installer_footer() {
  terminal_ui_enabled || return 0
  printf '\n%s%sInstall complete%s\n' "$INSTALL_BOLD" "$INSTALL_GREEN" "$INSTALL_RESET"
}

start_step() {
  local label progress
  label="$1"
  INSTALL_STEP=$((INSTALL_STEP + 1))
  progress="[$INSTALL_STEP/$INSTALL_TOTAL_STEPS] $label"
  start_spinner "$progress"
}

finish_step() {
  local label
  label="$1"

  stop_spinner
  if terminal_ui_enabled; then
    printf '%s[done]%s %s\n' "$INSTALL_GREEN" "$INSTALL_RESET" "$label"
  fi
}

fail_step() {
  local label
  label="$1"

  stop_spinner
  if terminal_ui_enabled; then
    printf '%s[fail]%s %s\n' "$INSTALL_RED" "$INSTALL_RESET" "$label" >&2
  fi
}

run_step() {
  local label status
  label="$1"
  shift

  start_step "$label"
  if "$@"; then
    status=0
  else
    status=$?
  fi

  if [ "$status" -eq 0 ]; then
    finish_step "$label"
  else
    fail_step "$label"
  fi

  return "$status"
}

cleanup_terminal_ui() {
  stop_spinner
}

log() {
  stop_spinner
  printf '[vibe-research-install] %s\n' "$*"
}

fail() {
  stop_spinner
  if terminal_ui_enabled; then
    printf '%s[error]%s %s\n' "$INSTALL_RED" "$INSTALL_RESET" "$*" >&2
  fi
  printf '[vibe-research-install] %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

run_command_with_timeout() {
  local timeout_seconds
  timeout_seconds="$1"
  shift

  case "$timeout_seconds" in
    ""|*[!0-9]*)
      fail "Invalid VIBE_RESEARCH_CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS=$timeout_seconds; use a number of seconds, or 0 to disable."
      ;;
  esac

  if [ "$timeout_seconds" = "0" ]; then
    "$@"
    return $?
  fi

  if has_command timeout; then
    timeout "${timeout_seconds}s" "$@"
    return $?
  fi

  if has_command perl; then
    perl -e '
use strict;
use warnings;

my $timeout = shift @ARGV;
my $pid = fork();
die "fork failed: $!\n" unless defined $pid;

if ($pid == 0) {
  setpgrp(0, 0);
  exec @ARGV;
  die "exec failed: $!\n";
}

my $deadline = time + $timeout;
while (1) {
  my $done = waitpid($pid, 1);
  if ($done == $pid) {
    my $status = $?;
    if ($status & 127) {
      exit(128 + ($status & 127));
    }
    exit($status >> 8);
  }

  if (time >= $deadline) {
    kill "TERM", -$pid;
    sleep 5;
    kill "KILL", -$pid;
    waitpid($pid, 0);
    exit 124;
  }

  select undef, undef, undef, 0.2;
}
' "$timeout_seconds" "$@"
    return $?
  fi

  "$@"
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

is_linux() {
  [ "$(uname -s)" = "Linux" ]
}

normalize_macos_locale() {
  if ! is_macos; then
    return
  fi

  case "${LC_ALL:-} ${LC_CTYPE:-} ${LANG:-}" in
    *C.UTF-8*)
      local fallback_locale
      fallback_locale="${VIBE_RESEARCH_MACOS_LOCALE:-${REMOTE_VIBES_MACOS_LOCALE:-en_US.UTF-8}}"
      export LANG="$fallback_locale"
      export LC_CTYPE="$fallback_locale"
      export LC_ALL="$fallback_locale"
      log "Using macOS locale $fallback_locale instead of unsupported C.UTF-8"
      ;;
  esac
}

is_root() {
  [ "$(id -u)" -eq 0 ]
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

applescript_string_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

run_as_root_with_macos_prompt() {
  if [ "$(uname -s 2>/dev/null || true)" != "Darwin" ] || ! has_command osascript; then
    return 1
  fi

  case "${VIBE_RESEARCH_MACOS_ADMIN_PROMPT:-${REMOTE_VIBES_MACOS_ADMIN_PROMPT:-1}}" in
    0 | false | False | FALSE | no | No | NO | off | Off | OFF)
      return 1
      ;;
  esac

  local command_string arg
  command_string=""
  for arg in "$@"; do
    command_string="${command_string:+$command_string }$(shell_quote "$arg")"
  done

  osascript -e "do shell script \"$(applescript_string_escape "$command_string")\" with administrator privileges"
}

run_as_root() {
  if is_root; then
    "$@"
    return
  fi

  if [ ! -t 0 ] && run_as_root_with_macos_prompt "$@"; then
    return
  fi

  if has_command sudo; then
    sudo "$@"
    return
  fi

  fail "Missing sudo. Re-run as root, or install sudo first."
}

run_as_root_preserving_env() {
  if is_root; then
    "$@"
    return
  fi

  if [ ! -t 0 ] && run_as_root_with_macos_prompt "$@"; then
    return
  fi

  if has_command sudo; then
    sudo -E "$@"
    return
  fi

  fail "Missing sudo. Re-run as root, or install sudo first."
}

try_run_as_root() {
  if is_root; then
    "$@"
    return
  fi

  if [ ! -t 0 ] && run_as_root_with_macos_prompt "$@"; then
    return
  fi

  if has_command sudo; then
    sudo "$@"
    return
  fi

  return 1
}

try_run_as_root_noninteractive() {
  if is_root; then
    "$@"
    return
  fi

  if has_command sudo; then
    sudo -n "$@"
    return
  fi

  return 1
}

can_run_as_root_noninteractive() {
  if is_root; then
    return 0
  fi

  has_command sudo && sudo -n true >/dev/null 2>&1
}

can_install_with_apt() {
  [ "$INSTALL_SYSTEM_DEPS" != "0" ] && has_command apt-get
}

apt_update_once() {
  if [ "$APT_UPDATED" = "1" ]; then
    return
  fi

  log "Updating apt package indexes"
  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get update
  APT_UPDATED=1
}

apt_install() {
  if ! can_install_with_apt; then
    return 1
  fi

  apt_update_once
  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

node_major_version() {
  if ! has_command node; then
    return 1
  fi

  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || return 1
}

node_is_supported() {
  local major
  major="$(node_major_version 2>/dev/null || true)"
  [ -n "$major" ] && [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

latest_macos_node_pkg_url() {
  local filename
  filename="$(
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" |
      awk '/ node-v.*\.pkg$/ { print $2; exit }'
  )"

  if [ -z "$filename" ]; then
    return 1
  fi

  printf 'https://nodejs.org/dist/latest-v%s.x/%s\n' "$NODE_MAJOR" "$filename"
}

install_macos_node() {
  local pkg_url temp_dir pkg_path

  if ! has_command curl; then
    fail "Missing curl. Install curl first, then rerun this installer."
  fi

  if ! has_command installer; then
    fail "Missing macOS installer command. Install Node.js ${NODE_MAJOR}.x from https://nodejs.org/, then rerun this installer."
  fi

  pkg_url="$(latest_macos_node_pkg_url)"
  if [ -z "$pkg_url" ]; then
    fail "Could not find the latest Node.js ${NODE_MAJOR}.x macOS package. Install Node.js from https://nodejs.org/, then rerun this installer."
  fi

  temp_dir="$(mktemp -d)"
  pkg_path="$temp_dir/node.pkg"
  log "Installing Node.js ${NODE_MAJOR}.x for macOS from $pkg_url"

  if ! curl -fsSL "$pkg_url" -o "$pkg_path"; then
    rm -rf "$temp_dir"
    fail "Failed to download Node.js macOS package."
  fi

  if ! run_as_root installer -pkg "$pkg_path" -target /; then
    rm -rf "$temp_dir"
    fail "Failed to install Node.js macOS package."
  fi

  rm -rf "$temp_dir"

  case ":$PATH:" in
    *:/usr/local/bin:*) ;;
    *)
      PATH="/usr/local/bin:$PATH"
      export PATH
      ;;
  esac
}

linux_node_arch() {
  case "$(uname -m 2>/dev/null || true)" in
    x86_64 | amd64)
      printf 'x64\n'
      ;;
    aarch64 | arm64)
      printf 'arm64\n'
      ;;
    armv7l)
      printf 'armv7l\n'
      ;;
    *)
      return 1
      ;;
  esac
}

latest_linux_node_tarball_name() {
  local arch suffix
  arch="$(linux_node_arch)" || return 1
  suffix="-linux-${arch}.tar.xz"

  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" |
    awk -v suffix="$suffix" '
      length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix {
        print $2
        exit
      }
    '
}

install_user_node() {
  local filename base_name tarball_url temp_dir archive_path extracted_dir install_dir tool

  if ! is_linux; then
    return 1
  fi

  if ! has_command curl; then
    fail "Missing curl. Install curl first, then rerun this installer."
  fi

  if ! has_command tar; then
    fail "Missing tar. Install tar first, then rerun this installer."
  fi

  filename="$(latest_linux_node_tarball_name || true)"
  if [ -z "$filename" ]; then
    fail "Could not find a Node.js ${NODE_MAJOR}.x Linux tarball for architecture $(uname -m 2>/dev/null || printf unknown). Install Node.js ${NODE_MAJOR}.x manually, then rerun this installer."
  fi

  base_name="${filename%.tar.xz}"
  tarball_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${filename}"
  temp_dir="$(mktemp -d)"
  archive_path="$temp_dir/$filename"

  log "Installing Node.js ${NODE_MAJOR}.x for Linux under $NODE_INSTALL_ROOT"

  if ! curl -fsSL "$tarball_url" -o "$archive_path"; then
    rm -rf "$temp_dir"
    fail "Failed to download Node.js Linux tarball."
  fi

  if ! tar -xJf "$archive_path" -C "$temp_dir"; then
    rm -rf "$temp_dir"
    fail "Failed to extract Node.js Linux tarball. Install xz/tar support or Node.js ${NODE_MAJOR}.x manually, then rerun this installer."
  fi

  extracted_dir="$temp_dir/$base_name"
  if [ ! -x "$extracted_dir/bin/node" ] || [ ! -x "$extracted_dir/bin/npm" ]; then
    rm -rf "$temp_dir"
    fail "Downloaded Node.js tarball did not contain node and npm."
  fi

  mkdir -p "$NODE_INSTALL_ROOT"
  install_dir="$NODE_INSTALL_ROOT/$base_name"
  rm -rf "$install_dir"
  mv "$extracted_dir" "$install_dir"
  ln -sfn "$install_dir" "$NODE_INSTALL_ROOT/current"
  rm -rf "$temp_dir"

  mkdir -p "$NODE_BIN_DIR"
  for tool in node npm npx corepack; do
    if [ -x "$NODE_INSTALL_ROOT/current/bin/$tool" ]; then
      if [ -L "$NODE_BIN_DIR/$tool" ] || [ ! -e "$NODE_BIN_DIR/$tool" ]; then
        ln -sfn "$NODE_INSTALL_ROOT/current/bin/$tool" "$NODE_BIN_DIR/$tool" 2>/dev/null || true
      fi
    fi
  done

  prepend_path_dir "$NODE_BIN_DIR"
  prepend_path_dir "$NODE_INSTALL_ROOT/current/bin"
}

ensure_base_packages() {
  if ! can_install_with_apt; then
    return
  fi

  log "Installing base packages"
  apt_install ca-certificates curl git bash python3 make g++ lsof tmux
}

install_nodesource_node() {
  if is_macos; then
    install_macos_node
    return
  fi

  if ! can_install_with_apt; then
    install_user_node
    return
  fi

  apt_install ca-certificates curl gnupg

  if ! has_command curl; then
    fail "Missing curl after package install."
  fi

  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  if is_root; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  fi

  APT_UPDATED=0
  apt_install nodejs
}

ensure_node() {
  if node_is_supported && has_command npm; then
    log "Using Node $(node -v) and npm $(npm -v)"
    return
  fi

  install_nodesource_node

  if ! node_is_supported; then
    fail "Node.js $(node -v 2>/dev/null || printf 'missing') is not supported. Vibe Research needs Node.js >=${MIN_NODE_MAJOR}."
  fi

  if ! has_command npm; then
    fail "npm is missing after Node.js install."
  fi

  log "Using Node $(node -v) and npm $(npm -v)"
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

path_contains_dir() {
  local dir="$1"
  case ":$PATH:" in
    *:"$dir":*) return 0 ;;
  esac

  return 1
}

can_prepare_launcher_dir() {
  local dir parent
  dir="$1"
  parent="$(dirname "$dir")"

  if [ -d "$dir" ] && [ -w "$dir" ]; then
    return 0
  fi

  if [ ! -e "$dir" ] && [ -w "$parent" ]; then
    return 0
  fi

  can_run_as_root_noninteractive
}

resolve_launcher_bin_dir() {
  local candidate

  if [ -n "$USER_BIN_DIR" ]; then
    printf '%s\n' "$USER_BIN_DIR"
    return
  fi

  for candidate in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin /opt/homebrew/bin; do
    if path_contains_dir "$candidate" && can_prepare_launcher_dir "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf '%s\n' "$HOME/.local/bin"
}

refresh_claude_command() {
  local resolved native_bin
  native_bin="$HOME/.local/bin/claude"

  if [ -x "$native_bin" ]; then
    CLAUDE_COMMAND="$native_bin"
    prepend_path_dir "$HOME/.local/bin"
    return 0
  fi

  if [ -x "$CLAUDE_COMMAND" ]; then
    return 0
  fi

  if resolved="$(command -v "$CLAUDE_COMMAND" 2>/dev/null)" && [ -n "$resolved" ]; then
    CLAUDE_COMMAND="$resolved"
    return 0
  fi

  if resolved="$(command -v claude 2>/dev/null)" && [ -n "$resolved" ]; then
    CLAUDE_COMMAND="$resolved"
    return 0
  fi

  return 1
}

claude_code_is_usable() {
  refresh_claude_command || return 1
  "$CLAUDE_COMMAND" --version >/dev/null 2>&1
}

log_claude_code_version() {
  local version
  version="$("$CLAUDE_COMMAND" --version 2>/dev/null | head -n 1 || true)"
  log "Using Claude Code${version:+ $version}"
}

install_claude_code_native() {
  if [ "$CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS" = "0" ]; then
    log "Installing Claude Code using Anthropic's native installer"
  else
    log "Installing Claude Code using Anthropic's native installer (timeout ${CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS}s)"
  fi

  run_command_with_timeout "$CLAUDE_CODE_INSTALL_TIMEOUT_SECONDS" bash -c 'curl -fsSL "$1" | bash' _ "https://claude.ai/install.sh"
}

install_claude_code_with_npm() {
  local npm_prefix

  if ! has_command npm; then
    log "Skipping Claude Code npm fallback because npm is missing"
    return 1
  fi

  npm_prefix="$HOME/.local"
  mkdir -p "$npm_prefix"
  prepend_path_dir "$npm_prefix/bin"

  log "Installing Claude Code using npm fallback under $npm_prefix"
  NPM_CONFIG_PREFIX="$npm_prefix" npm install -g @anthropic-ai/claude-code --no-audit --no-fund
}

ensure_claude_code() {
  local native_status used_npm_fallback

  if claude_code_is_usable; then
    log_claude_code_version
    return
  fi

  case "$INSTALL_CLAUDE_CODE" in
    0 | false | no | off)
      log "Skipping Claude Code install because VIBE_RESEARCH_INSTALL_CLAUDE_CODE=0"
      return
      ;;
    auto | detect | "")
      log "Claude Code is not installed yet; continuing so onboarding can install or choose a coding agent"
      return
      ;;
  esac

  if ! is_linux && ! is_macos; then
    log "Skipping Claude Code install because automatic setup is supported on macOS/Linux/WSL only"
    return
  fi

  if ! has_command curl; then
    fail "Missing curl. Install curl first, then rerun this installer to install Claude Code."
  fi

  used_npm_fallback=0
  if install_claude_code_native; then
    :
  else
    native_status=$?
    log "Claude Code native installer did not complete (exit ${native_status}); trying npm fallback"
    if ! install_claude_code_with_npm; then
      fail "Claude Code install failed. Rerun after fixing it, or set VIBE_RESEARCH_INSTALL_CLAUDE_CODE=0 to skip Claude Code."
    fi
    used_npm_fallback=1
  fi

  if ! claude_code_is_usable && [ "$used_npm_fallback" = "0" ]; then
    log "Claude Code native installer finished, but the claude command is not usable; trying npm fallback"
    if ! install_claude_code_with_npm; then
      fail "Claude Code install failed. Rerun after fixing it, or set VIBE_RESEARCH_INSTALL_CLAUDE_CODE=0 to skip Claude Code."
    fi
  fi

  if ! claude_code_is_usable; then
    fail "Claude Code installed, but the claude command was not found. Open a new shell, or add $HOME/.local/bin to PATH."
  fi

  log_claude_code_version
}

tailscale_app_cli() {
  local candidate

  for candidate in \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

refresh_tailscale_command() {
  local resolved

  if [ -x "$TAILSCALE_COMMAND" ]; then
    return 0
  fi

  if resolved="$(command -v "$TAILSCALE_COMMAND" 2>/dev/null)" && [ -n "$resolved" ]; then
    TAILSCALE_COMMAND="$resolved"
    return 0
  fi

  if resolved="$(command -v tailscale 2>/dev/null)" && [ -n "$resolved" ]; then
    TAILSCALE_COMMAND="$resolved"
    return 0
  fi

  if resolved="$(tailscale_app_cli 2>/dev/null)" && [ -n "$resolved" ]; then
    TAILSCALE_COMMAND="$resolved"
    return 0
  fi

  return 1
}

latest_macos_tailscale_pkg_url() {
  curl -fsSL https://pkgs.tailscale.com/stable/ |
    sed -n 's/.*href="\([^"]*Tailscale-[^"]*-macos\.pkg\)".*/\1/p' |
    head -n 1 |
    while IFS= read -r href; do
      case "$href" in
        http*) printf '%s\n' "$href" ;;
        /*) printf 'https://pkgs.tailscale.com%s\n' "$href" ;;
        *) printf 'https://pkgs.tailscale.com/stable/%s\n' "$href" ;;
      esac
    done
}

install_tailscale_linux() {
  if ! has_command curl; then
    fail "Missing curl. Install curl, or rerun the README quickstart command that bootstraps curl first."
  fi

  log "Installing Tailscale for Linux"
  if is_root; then
    curl -fsSL https://tailscale.com/install.sh | sh
  elif has_command sudo; then
    curl -fsSL https://tailscale.com/install.sh | sudo sh
  else
    fail "Missing sudo. Re-run as root, or install Tailscale manually first."
  fi
}

install_tailscale_macos() {
  local pkg_url temp_dir pkg_path

  if ! has_command curl; then
    fail "Missing curl. Install curl first, then rerun the installer."
  fi

  if ! has_command installer; then
    fail "Missing macOS installer command. Install Tailscale from https://tailscale.com/download/mac, then rerun this installer."
  fi

  pkg_url="$(latest_macos_tailscale_pkg_url)"
  if [ -z "$pkg_url" ]; then
    fail "Could not find the latest macOS Tailscale package. Install Tailscale from https://tailscale.com/download/mac, then rerun this installer."
  fi

  temp_dir="$(mktemp -d)"
  pkg_path="$temp_dir/tailscale.pkg"
  log "Installing Tailscale for macOS from $pkg_url"

  if ! curl -fsSL "$pkg_url" -o "$pkg_path"; then
    rm -rf "$temp_dir"
    fail "Failed to download Tailscale macOS package."
  fi

  if ! run_as_root installer -pkg "$pkg_path" -target /; then
    rm -rf "$temp_dir"
    fail "Failed to install Tailscale macOS package."
  fi

  rm -rf "$temp_dir"

  if has_command open; then
    open -a Tailscale >/dev/null 2>&1 || true
  fi
}

install_tailscale() {
  if is_linux; then
    install_tailscale_linux
    return
  fi

  if is_macos; then
    install_tailscale_macos
    return
  fi

  fail "Automatic Tailscale install is supported on Linux and macOS only. Install Tailscale manually, then rerun this installer."
}

run_tailscale_up() {
  if is_linux && [ "$TAILSCALE_USE_SUDO" != "0" ]; then
    if [ -n "$TAILSCALE_AUTHKEY" ]; then
      run_as_root "$TAILSCALE_COMMAND" up --auth-key "$TAILSCALE_AUTHKEY"
    else
      run_as_root "$TAILSCALE_COMMAND" up
    fi
    return
  fi

  if [ -n "$TAILSCALE_AUTHKEY" ]; then
    "$TAILSCALE_COMMAND" up --auth-key "$TAILSCALE_AUTHKEY"
  else
    "$TAILSCALE_COMMAND" up
  fi
}

tailscale_daemon_ready() {
  local output status

  output="$("$TAILSCALE_COMMAND" status --json 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then
    return 0
  fi

  case "$output" in
    *tailscaled*running* | *tailscaled*Running* | *local\ tailscaled* | *connect*tailscaled*)
      return 1
      ;;
  esac

  # If the CLI reached tailscaled but reported "logged out" or another account
  # state, the daemon is ready enough for `tailscale up` to handle onboarding.
  return 0
}

wait_for_tailscale_daemon() {
  local attempt max_wait

  if ! is_linux || [ "$TAILSCALE_USE_SUDO" = "0" ]; then
    return 0
  fi

  max_wait="$TAILSCALE_DAEMON_WAIT_SECONDS"
  case "$max_wait" in
    "" | *[!0-9]*)
      max_wait=15
      ;;
  esac

  if [ "$max_wait" -lt 1 ]; then
    max_wait=1
  fi

  attempt=0
  while [ "$attempt" -lt "$max_wait" ]; do
    if tailscale_daemon_ready; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  return 1
}

start_tailscaled_userspace() {
  local tailscaled_command

  if ! is_linux || [ "$TAILSCALE_USE_SUDO" = "0" ]; then
    return 1
  fi

  if ! tailscaled_command="$(command -v tailscaled 2>/dev/null)" || [ -z "$tailscaled_command" ]; then
    return 1
  fi

  log "Starting tailscaled directly in userspace networking mode"
  try_run_as_root mkdir -p /run/tailscale /var/lib/tailscale /var/cache/tailscale || return 1
  try_run_as_root rm -f /run/tailscale/tailscaled.sock || true
  try_run_as_root sh -c 'nohup "$1" --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=41641 >"$2" 2>&1 &' sh "$tailscaled_command" "$TAILSCALED_LOG_FILE" || return 1
  wait_for_tailscale_daemon
}

start_tailscale_daemon() {
  if ! is_linux || [ "$TAILSCALE_USE_SUDO" = "0" ]; then
    return
  fi

  if has_command systemctl; then
    if systemctl is-active --quiet tailscaled >/dev/null 2>&1; then
      if wait_for_tailscale_daemon; then
        return
      fi
    fi

    log "Starting tailscaled service"
    if try_run_as_root systemctl enable --now tailscaled >/dev/null 2>&1; then
      if wait_for_tailscale_daemon; then
        return
      fi
    fi

    if try_run_as_root systemctl start tailscaled >/dev/null 2>&1; then
      if wait_for_tailscale_daemon; then
        return
      fi
    fi
  fi

  if has_command service; then
    log "Starting tailscaled service"
    if try_run_as_root service tailscaled start >/dev/null 2>&1; then
      if wait_for_tailscale_daemon; then
        return
      fi
    fi
  fi

  start_tailscaled_userspace || true
}

ensure_tailscale() {
  local ip_address

  if [ "$INSTALL_TAILSCALE" = "0" ]; then
    log "Skipping Tailscale setup because VIBE_RESEARCH_INSTALL_TAILSCALE=0"
    return
  fi

  if [ "$INSTALL_TAILSCALE" = "auto" ] || [ -z "$INSTALL_TAILSCALE" ]; then
    if ! refresh_tailscale_command; then
      log "Tailscale not found; continuing with local/LAN URLs. Install Tailscale later for private remote access."
      return
    fi

    log "Using Tailscale command: $TAILSCALE_COMMAND"
    if "$TAILSCALE_COMMAND" ip -4 >/dev/null 2>&1; then
      ip_address="$("$TAILSCALE_COMMAND" ip -4 2>/dev/null | head -n 1 || true)"
      log "Tailscale is already connected${ip_address:+ at $ip_address}"
    else
      log "Tailscale is installed but not connected; continuing with local/LAN URLs. Run tailscale up later for private remote access."
    fi
    return
  fi

  if ! refresh_tailscale_command; then
    install_tailscale
    if ! refresh_tailscale_command; then
      fail "Tailscale installed, but the tailscale command was not found. Open a new shell and rerun this installer."
    fi
  fi

  log "Using Tailscale command: $TAILSCALE_COMMAND"
  start_tailscale_daemon

  if "$TAILSCALE_COMMAND" ip -4 >/dev/null 2>&1; then
    ip_address="$("$TAILSCALE_COMMAND" ip -4 2>/dev/null | head -n 1 || true)"
    log "Tailscale is already connected${ip_address:+ at $ip_address}"
    return
  fi

  if [ "$TAILSCALE_UP" = "0" ]; then
    log "Skipping Tailscale login because VIBE_RESEARCH_TAILSCALE_UP=0"
    return
  fi

  log "Starting Tailscale. Follow the login URL printed below if prompted."
  if ! run_tailscale_up; then
    if is_linux && [ "$TAILSCALE_USE_SUDO" != "0" ]; then
      log "Tailscale login could not reach tailscaled yet; restarting the daemon and retrying once."
      start_tailscale_daemon
      if run_tailscale_up; then
        :
      else
        fail "Tailscale login failed. If tailscaled is not running, run: sudo systemctl enable --now tailscaled, then rerun this installer."
      fi
    else
      fail "Tailscale login failed. If tailscaled is not running, run: sudo systemctl enable --now tailscaled, then rerun this installer."
    fi
  fi

  if ! "$TAILSCALE_COMMAND" ip -4 >/dev/null 2>&1; then
    fail "Tailscale is installed but not connected yet. Finish Tailscale sign-in, then rerun this installer."
  fi

  ip_address="$("$TAILSCALE_COMMAND" ip -4 2>/dev/null | head -n 1 || true)"
  log "Tailscale connected${ip_address:+ at $ip_address}"
}

systemd_is_running() {
  local state

  if ! has_command systemctl; then
    return 1
  fi

  state="$(systemctl is-system-running 2>/dev/null || true)"
  [ "$state" = "running" ] || [ "$state" = "degraded" ]
}

stop_existing_systemd_service() {
  if [ "$INSTALL_SERVICE" = "0" ]; then
    return
  fi

  if ! is_linux || ! has_command systemctl; then
    return
  fi

  if ! systemctl cat "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    return
  fi

  log "Stopping existing systemd service ${SERVICE_NAME}.service before update"
  if ! try_run_as_root_noninteractive systemctl stop "${SERVICE_NAME}.service"; then
    log "Could not stop existing systemd service without sudo; continuing with foreground launch"
  fi
}

wait_for_systemd_service_active() {
  local attempt max_attempts

  max_attempts="${VIBE_RESEARCH_SYSTEMD_START_ATTEMPTS:-${REMOTE_VIBES_SYSTEMD_START_ATTEMPTS:-6}}"
  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if try_run_as_root_noninteractive systemctl is-active --quiet "${SERVICE_NAME}.service" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  return 1
}

vibe_research_server_is_running() {
  local state_dir port pid

  state_dir="$1"
  port="$2"

  if [ -s "$state_dir/server.pid" ]; then
    pid="$(cat "$state_dir/server.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if has_command curl && curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/state" -H "X-Vibe-Research-API: 1" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

wait_for_vibe_research_server() {
  local state_dir port attempt max_attempts

  state_dir="$1"
  port="$2"
  max_attempts="${VIBE_RESEARCH_SERVER_START_ATTEMPTS:-${REMOTE_VIBES_SERVER_START_ATTEMPTS:-6}}"
  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if vibe_research_server_is_running "$state_dir" "$port"; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  return 1
}

install_systemd_service() {
  local service_user state_dir wiki_dir port service_file temp_file

  if [ "$INSTALL_SERVICE" = "0" ]; then
    log "Skipping service install because VIBE_RESEARCH_INSTALL_SERVICE=0"
    return
  fi

  if ! is_linux; then
    return
  fi

  if ! has_command systemctl || ! systemd_is_running; then
    log "Skipping service install because systemd is not available"
    return
  fi

  if ! can_run_as_root_noninteractive; then
    log "Skipping service install because sudo is not available without a password"
    return
  fi

  service_user="$(id -un)"
  state_dir="${VIBE_RESEARCH_STATE_DIR:-${REMOTE_VIBES_STATE_DIR:-$HOME/.vibe-research}}"
  wiki_dir="${VIBE_RESEARCH_WIKI_DIR:-${REMOTE_VIBES_WIKI_DIR:-}}"
  workspace_dir="${VIBE_RESEARCH_WORKSPACE_DIR:-${REMOTE_VIBES_WORKSPACE_DIR:-$HOME/vibe-projects}}"
  port="${VIBE_RESEARCH_PORT:-${REMOTE_VIBES_PORT:-4123}}"
  service_file="$SYSTEMD_SERVICE_DIR/${SERVICE_NAME}.service"
  temp_file="$(mktemp)"

  cat >"$temp_file" <<EOF
[Unit]
Description=Vibe Research
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=forking
User=$service_user
WorkingDirectory=$INSTALL_DIR
Environment=VIBE_RESEARCH_STATE_DIR=$state_dir
Environment=VIBE_RESEARCH_WORKSPACE_DIR=$workspace_dir
$(if [ -n "$wiki_dir" ]; then printf 'Environment=VIBE_RESEARCH_WIKI_DIR=%s\n' "$wiki_dir"; fi)
Environment=VIBE_RESEARCH_PORT=$port
Environment=VIBE_RESEARCH_FORCE_RESTART=1
ExecStart=$INSTALL_DIR/start.sh
PIDFile=$state_dir/server.pid
Restart=always
RestartSec=5
KillMode=process
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
EOF

  log "Installing systemd service $SERVICE_NAME.service"
  if ! try_run_as_root_noninteractive install -m 0644 "$temp_file" "$service_file"; then
    rm -f "$temp_file"
    log "Could not install systemd service; Vibe Research is still running for this session"
    return
  fi

  rm -f "$temp_file"

  if ! try_run_as_root_noninteractive systemctl daemon-reload; then
    log "Could not reload systemd; Vibe Research is still running for this session"
    return
  fi

  if ! try_run_as_root_noninteractive systemctl enable "${SERVICE_NAME}.service"; then
    log "Could not enable systemd service; Vibe Research is still running for this session"
    return
  fi

  if ! try_run_as_root_noninteractive systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    log "systemd restart did not report success; checking ${SERVICE_NAME}.service status"
    if ! wait_for_systemd_service_active; then
      if wait_for_vibe_research_server "$state_dir" "$port"; then
        log "Vibe Research is running; ${SERVICE_NAME}.service is enabled but still settling"
        return
      fi
      log "Could not start systemd service; Vibe Research is still running for this session"
      return
    fi
  elif ! wait_for_systemd_service_active; then
    if wait_for_vibe_research_server "$state_dir" "$port"; then
      log "Vibe Research is running; ${SERVICE_NAME}.service is enabled but still settling"
      return
    fi
    log "Could not confirm systemd service startup; Vibe Research is still running for this session"
    return
  fi

  log "Enabled ${SERVICE_NAME}.service for reboot and crash recovery"
}

resolve_repo_url() {
  if [ -n "$REPO_URL" ]; then
    printf '%s\n' "$REPO_URL"
    return
  fi

  printf 'https://github.com/%s.git\n' "$REPO_SLUG"
}

latest_release_tag() {
  if [ "$UPDATE_CHANNEL" != "release" ] || [ "$REPO_REF_WAS_SET" = "1" ] || [ -n "$REPO_URL" ]; then
    return 1
  fi

  if ! has_command curl; then
    return 1
  fi

  curl -fsSL "https://raw.githubusercontent.com/${REPO_SLUG}/main/release-channel.json" 2>/dev/null |
    sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

latest_github_release_tag() {
  if [ "$UPDATE_CHANNEL" != "release" ] || [ "$REPO_REF_WAS_SET" = "1" ] || [ -n "$REPO_URL" ]; then
    return 1
  fi

  if ! has_command curl; then
    return 1
  fi

  curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

resolve_checkout_ref() {
  local tag

  if tag="$(latest_github_release_tag)" && [ -n "$tag" ]; then
    printf '%s\n' "$tag"
    return
  fi

  if tag="$(latest_release_tag)" && [ -n "$tag" ]; then
    printf '%s\n' "$tag"
    return
  fi

  printf '%s\n' "$REPO_REF"
}

prepare_start_environment() {
  if [ -z "${VIBE_RESEARCH_FORCE_RESTART+x}" ] && [ -z "${REMOTE_VIBES_FORCE_RESTART+x}" ]; then
    export VIBE_RESEARCH_FORCE_RESTART=1
    export REMOTE_VIBES_FORCE_RESTART=1
    return
  fi

  export VIBE_RESEARCH_FORCE_RESTART="${VIBE_RESEARCH_FORCE_RESTART:-${REMOTE_VIBES_FORCE_RESTART:-}}"
  export REMOTE_VIBES_FORCE_RESTART="${REMOTE_VIBES_FORCE_RESTART:-$VIBE_RESEARCH_FORCE_RESTART}"
}

ensure_command() {
  if has_command "$1"; then
    return
  fi

  fail "Missing required command: $1"
}

ensure_required_commands() {
  ensure_command git
  ensure_command bash
}

clone_repo() {
  local primary_url ssh_url checkout_ref
  primary_url="$(resolve_repo_url)"
  ssh_url="git@github.com:${REPO_SLUG}.git"
  checkout_ref="$(resolve_checkout_ref)"

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -n "$REPO_URL" ]; then
    log "Cloning into $INSTALL_DIR"
    git clone --depth 1 --branch "$checkout_ref" "$primary_url" "$INSTALL_DIR"
    return
  fi

  if [ "$checkout_ref" != "$REPO_REF" ]; then
    log "Cloning latest release $checkout_ref into $INSTALL_DIR"
  else
    log "Cloning into $INSTALL_DIR"
  fi

  if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$checkout_ref" "$primary_url" "$INSTALL_DIR"; then
    return
  fi

  log "HTTPS clone failed, trying SSH"
  git clone --depth 1 --branch "$checkout_ref" "$ssh_url" "$INSTALL_DIR"
}

restore_managed_prompt_file() {
  local file="$1"

  if [ -f "$file" ] && grep -Fq -e "$MANAGED_PROMPT_MARKER" -e "$LEGACY_MANAGED_PROMPT_MARKER" "$file"; then
    git checkout -- "$file" >/dev/null 2>&1 || true
    return
  fi

  if git show "HEAD:$file" 2>/dev/null | grep -Fq -e "$MANAGED_PROMPT_MARKER" -e "$LEGACY_MANAGED_PROMPT_MARKER"; then
    git checkout -- "$file" >/dev/null 2>&1 || true
  fi
}

restore_managed_prompt_files() {
  restore_managed_prompt_file AGENTS.md
  restore_managed_prompt_file CLAUDE.md
  restore_managed_prompt_file GEMINI.md
}

restore_installer_generated_files() {
  if [ -n "$(git status --porcelain -- package-lock.json 2>/dev/null)" ]; then
    log "Restoring generated package-lock change before update"
    git checkout -- package-lock.json >/dev/null 2>&1 || true
  fi
}

reset_checkout_changes() {
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    log "Discarding local app checkout changes before update"
    git reset --hard HEAD >/dev/null 2>&1
    git clean -fd >/dev/null 2>&1
  fi
}

update_repo() {
  local ssh_url checkout_ref
  ssh_url="git@github.com:${REPO_SLUG}.git"
  checkout_ref="$(resolve_checkout_ref)"

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    fail "$INSTALL_DIR exists but is not a git checkout"
  fi

  cd "$INSTALL_DIR"
  restore_managed_prompt_files
  restore_installer_generated_files
  reset_checkout_changes

  if [ "$checkout_ref" != "$REPO_REF" ]; then
    log "Updating existing checkout to latest release $checkout_ref"
    if ! GIT_TERMINAL_PROMPT=0 git fetch --force origin "refs/tags/${checkout_ref}:refs/tags/${checkout_ref}" --depth 1; then
      if [ -n "$REPO_URL" ]; then
        fail "Failed to update $INSTALL_DIR from $REPO_URL"
      fi

      log "HTTPS fetch failed, trying SSH"
      git remote set-url origin "$ssh_url"
      git fetch --force origin "refs/tags/${checkout_ref}:refs/tags/${checkout_ref}" --depth 1
    fi

    git checkout --detach "refs/tags/${checkout_ref}"
    return
  fi

  log "Updating existing checkout"
  if ! GIT_TERMINAL_PROMPT=0 git fetch origin "$REPO_REF" --depth 1; then
    if [ -n "$REPO_URL" ]; then
      fail "Failed to update $INSTALL_DIR from $REPO_URL"
    fi

    log "HTTPS fetch failed, trying SSH"
    git remote set-url origin "$ssh_url"
    git fetch origin "$REPO_REF" --depth 1
  fi

  git checkout -B "$REPO_REF" FETCH_HEAD
}

sync_app_checkout() {
  if [ -d "$INSTALL_DIR" ]; then
    update_repo
  else
    clone_repo
  fi
}

prepare_app_checkout() {
  stop_existing_systemd_service
  sync_app_checkout

  cd "$INSTALL_DIR"

  if [ ! -x "$INSTALL_DIR/start.sh" ]; then
    chmod +x "$INSTALL_DIR/start.sh"
  fi

  if [ -d "$INSTALL_DIR/bin" ]; then
    for helper in vibe-research vr-browser vr-browser-detour vr-browser-use vr-mailwatch vr-playwright vr-session-name vr-agentmail-reply vr-videomemory rv-browser rv-browser-detour rv-browser-use rv-mailwatch rv-playwright rv-session-name rv-agentmail-reply rv-videomemory codex claude open osascript google-chrome chrome chromium chromium-browser firefox; do
      if [ -f "$INSTALL_DIR/bin/$helper" ] && [ ! -x "$INSTALL_DIR/bin/$helper" ]; then
        chmod +x "$INSTALL_DIR/bin/$helper"
      fi
    done
  fi
}

install_launcher_command() {
  local launcher_source launcher_dir launcher_path path_was_ready
  launcher_source="$INSTALL_DIR/bin/vibe-research"

  if [ ! -f "$launcher_source" ]; then
    log "Skipping terminal command because $launcher_source is missing"
    return
  fi

  launcher_dir="$(resolve_launcher_bin_dir)"
  launcher_path="$launcher_dir/vibe-research"
  path_was_ready=0

  if path_contains_dir "$launcher_dir"; then
    path_was_ready=1
  fi

  if ! mkdir -p "$launcher_dir" 2>/dev/null; then
    try_run_as_root_noninteractive mkdir -p "$launcher_dir" || {
      log "Could not create $launcher_dir; skipping terminal command"
      return
    }
  fi

  chmod +x "$launcher_source" || true

  if [ -e "$launcher_path" ] && [ ! -L "$launcher_path" ]; then
    log "Leaving existing $launcher_path in place; run $launcher_source directly or set VIBE_RESEARCH_BIN_DIR to another directory."
    return
  fi

  if [ -L "$launcher_path" ]; then
    rm -f "$launcher_path" 2>/dev/null || try_run_as_root_noninteractive rm -f "$launcher_path" || {
      log "Could not update existing $launcher_path; skipping terminal command"
      return
    }
  fi

  if ! ln -s "$launcher_source" "$launcher_path" 2>/dev/null; then
    try_run_as_root_noninteractive ln -s "$launcher_source" "$launcher_path" || {
      log "Could not install $launcher_path; run $launcher_source directly or set VIBE_RESEARCH_BIN_DIR to a writable directory."
      return
    }
  fi

  log "Installed terminal command: $launcher_path"
  if [ "$path_was_ready" != "1" ]; then
    log "If 'vibe-research' is not found yet, open a new terminal or add $launcher_dir to PATH."
  fi
}

launch_vibe_research() {
  if [ "$SKIP_RUN" = "1" ]; then
    log "Skipping launch because VIBE_RESEARCH_SKIP_RUN=1"
    return
  fi

  prepare_start_environment
  log "Launching Vibe Research"
  "$INSTALL_DIR/start.sh"
}

main() {
  init_terminal_ui
  trap cleanup_terminal_ui EXIT

  if [ "$ENSURE_NODE_ONLY" = "1" ]; then
    INSTALL_TOTAL_STEPS=3
    print_installer_banner
    run_step "Terminal locale" normalize_macos_locale
    run_step "System packages" ensure_base_packages
    run_step "Node.js runtime" ensure_node
    print_installer_footer
    return
  fi

  print_installer_banner
  run_step "Terminal locale" normalize_macos_locale
  run_step "System packages" ensure_base_packages
  run_step "Node.js runtime" ensure_node
  run_step "Claude Code" ensure_claude_code
  run_step "Tailscale" ensure_tailscale
  run_step "Installer prerequisites" ensure_required_commands
  run_step "App checkout" prepare_app_checkout
  run_step "Terminal launcher" install_launcher_command
  run_step "Launch" launch_vibe_research
  run_step "Service setup" install_systemd_service
  print_installer_footer
}

main "$@"
