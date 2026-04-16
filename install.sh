#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${REMOTE_VIBES_REPO_SLUG:-Clamepending/remote-vibes}"
INSTALL_DIR="${REMOTE_VIBES_HOME:-$HOME/.remote-vibes/app}"
REPO_REF="${REMOTE_VIBES_REF:-main}"
REPO_URL="${REMOTE_VIBES_REPO_URL:-}"
SKIP_RUN="${REMOTE_VIBES_SKIP_RUN:-0}"
INSTALL_SYSTEM_DEPS="${REMOTE_VIBES_INSTALL_SYSTEM_DEPS:-1}"
NODE_MAJOR="${REMOTE_VIBES_NODE_MAJOR:-22}"
MIN_NODE_MAJOR=20
APT_UPDATED=0

log() {
  printf '[remote-vibes-install] %s\n' "$*"
}

fail() {
  printf '[remote-vibes-install] %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

is_root() {
  [ "$(id -u)" -eq 0 ]
}

run_as_root() {
  if is_root; then
    "$@"
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

  if has_command sudo; then
    sudo -E "$@"
    return
  fi

  fail "Missing sudo. Re-run as root, or install sudo first."
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

ensure_base_packages() {
  if ! can_install_with_apt; then
    return
  fi

  log "Installing base packages"
  apt_install ca-certificates curl git bash python3 make g++ lsof
}

install_nodesource_node() {
  if ! can_install_with_apt; then
    fail "Missing Node.js >=${MIN_NODE_MAJOR} and npm. Install Node.js ${NODE_MAJOR}.x or rerun on a Debian/Raspberry Pi OS system with apt-get."
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
    fail "Node.js $(node -v 2>/dev/null || printf 'missing') is not supported. Remote Vibes needs Node.js >=${MIN_NODE_MAJOR}."
  fi

  if ! has_command npm; then
    fail "npm is missing after Node.js install."
  fi

  log "Using Node $(node -v) and npm $(npm -v)"
}

resolve_repo_url() {
  if [ -n "$REPO_URL" ]; then
    printf '%s\n' "$REPO_URL"
    return
  fi

  printf 'https://github.com/%s.git\n' "$REPO_SLUG"
}

ensure_command() {
  if has_command "$1"; then
    return
  fi

  fail "Missing required command: $1"
}

clone_repo() {
  local primary_url ssh_url
  primary_url="$(resolve_repo_url)"
  ssh_url="git@github.com:${REPO_SLUG}.git"

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -n "$REPO_URL" ]; then
    log "Cloning into $INSTALL_DIR"
    git clone --depth 1 --branch "$REPO_REF" "$primary_url" "$INSTALL_DIR"
    return
  fi

  log "Cloning into $INSTALL_DIR"
  if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$REPO_REF" "$primary_url" "$INSTALL_DIR"; then
    return
  fi

  log "HTTPS clone failed, trying SSH"
  git clone --depth 1 --branch "$REPO_REF" "$ssh_url" "$INSTALL_DIR"
}

update_repo() {
  local ssh_url
  ssh_url="git@github.com:${REPO_SLUG}.git"

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    fail "$INSTALL_DIR exists but is not a git checkout"
  fi

  cd "$INSTALL_DIR"

  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    log "Local changes detected in $INSTALL_DIR, skipping update"
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

main() {
  ensure_base_packages
  ensure_node
  ensure_command git
  ensure_command bash

  if [ -d "$INSTALL_DIR" ]; then
    update_repo
  else
    clone_repo
  fi

  cd "$INSTALL_DIR"

  if [ ! -x "$INSTALL_DIR/start.sh" ]; then
    chmod +x "$INSTALL_DIR/start.sh"
  fi

  if [ -d "$INSTALL_DIR/bin" ]; then
    for helper in rv-browser rv-browser-detour rv-session-name codex claude open osascript google-chrome chrome chromium chromium-browser firefox; do
      if [ -f "$INSTALL_DIR/bin/$helper" ] && [ ! -x "$INSTALL_DIR/bin/$helper" ]; then
        chmod +x "$INSTALL_DIR/bin/$helper"
      fi
    done
  fi

  if [ "$SKIP_RUN" = "1" ]; then
    log "Skipping launch because REMOTE_VIBES_SKIP_RUN=1"
    return
  fi

  exec "$INSTALL_DIR/start.sh"
}

main "$@"
