#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${REMOTE_VIBES_REPO_SLUG:-Clamepending/remote-vibes}"
INSTALL_DIR="${REMOTE_VIBES_HOME:-$HOME/.remote-vibes}"
REPO_REF="${REMOTE_VIBES_REF:-main}"
REPO_URL="${REMOTE_VIBES_REPO_URL:-}"
SKIP_RUN="${REMOTE_VIBES_SKIP_RUN:-0}"

log() {
  printf '[remote-vibes-install] %s\n' "$*"
}

fail() {
  printf '[remote-vibes-install] %s\n' "$*" >&2
  exit 1
}

resolve_repo_url() {
  if [ -n "$REPO_URL" ]; then
    printf '%s\n' "$REPO_URL"
    return
  fi

  printf 'https://github.com/%s.git\n' "$REPO_SLUG"
}

ensure_command() {
  if command -v "$1" >/dev/null 2>&1; then
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
    for helper in rv-browser rv-browser-detour codex claude open osascript google-chrome chrome chromium chromium-browser firefox; do
      if [ -f "$INSTALL_DIR/bin/$helper" ] && [ ! -x "$INSTALL_DIR/bin/$helper" ]; then
        chmod +x "$INSTALL_DIR/bin/$helper"
      fi
    done
  fi

  if [ "$SKIP_RUN" = "1" ]; then
    log "Skipping launch because REMOTE_VIBES_SKIP_RUN=1"
    return
  fi

  ensure_command npm
  exec "$INSTALL_DIR/start.sh"
}

main "$@"
