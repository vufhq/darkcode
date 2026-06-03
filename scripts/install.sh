#!/bin/sh
# DarkCode CLI installer (macOS + Linux).
#
#   curl -fsSL https://darkcode.sh/install.sh | sh
#
# Downloads the prebuilt standalone binary for your platform from the latest
# GitHub Release, verifies its checksum, installs it to ~/.darkcode/bin, and
# adds that to your PATH. Override the install dir with DARKCODE_INSTALL.
set -eu

REPO="${DARKCODE_REPO:-vufhq/darkcode}"
INSTALL_DIR="${DARKCODE_INSTALL:-$HOME/.darkcode/bin}"
BIN="darkcode"

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
err()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- detect platform -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) err "Unsupported OS: $os. See https://darkcode.sh/docs for manual install." ;;
esac

case "$arch" in
  x86_64|amd64)  arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) err "Unsupported architecture: $arch." ;;
esac

asset="darkcode-${os}-${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

# --- download --------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

download() {
  # download <url> <dest>; returns non-zero on failure
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    err "Need curl or wget to install."
  fi
}

info "Downloading darkcode (${os}-${arch})…"
download "$url" "$tmp/$asset" || err "Download failed: $url
The release asset may not exist yet, or the repository's releases are private."

# --- verify checksum (best effort) -----------------------------------------
if download "${url}.sha256" "$tmp/$asset.sha256" 2>/dev/null; then
  expected="$(cut -d' ' -f1 "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
    err "Checksum mismatch — refusing to install."
  fi
  [ -n "$actual" ] && info "Checksum verified."
fi

# --- extract + install -----------------------------------------------------
info "Installing to ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset" -C "$tmp"
mv "$tmp/darkcode" "$INSTALL_DIR/$BIN"
chmod +x "$INSTALL_DIR/$BIN"

version="$("$INSTALL_DIR/$BIN" --version 2>/dev/null || echo "")"
printf '\n\033[32m✓ darkcode %s installed\033[0m → %s\n' "$version" "$INSTALL_DIR/$BIN"

# --- PATH ------------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;; # already on PATH
  *)
    line="export PATH=\"$INSTALL_DIR:\$PATH\""
    added=""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$rc" ] && ! grep -qsF "$INSTALL_DIR" "$rc"; then
        printf '\n# DarkCode\n%s\n' "$line" >> "$rc"
        added="$rc"
        break
      fi
    done
    printf '\n'
    if [ -n "$added" ]; then
      info "Added ${INSTALL_DIR} to PATH in ${added} — restart your shell or run:"
    else
      info "Add darkcode to your PATH:"
    fi
    printf '    %s\n' "$line"
    ;;
esac

printf '\nRun \033[1mdarkcode\033[0m to get started, then \033[1m/login\033[0m.\n'
