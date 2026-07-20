#!/bin/bash
set -e


BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()  { printf "${BOLD}${GREEN}▸${RESET} %s\n" "$1"; }
warn()  { printf "${BOLD}${YELLOW}▸${RESET} %s\n" "$1"; }
error() { printf "${BOLD}${RED}▸${RESET} %s\n" "$1"; exit 1; }

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# detect os
detect_os() {
  case "$(uname -s)" in
    Linux*)  os="linux";;
    Darwin*) os="mac";;
    MINGW*|MSYS*|CYGWIN*) os="windows";;
    *) error "Unsupported OS: $(uname -s)";;
  esac
  info "Detected OS: $os"
}

# check if node is installed
ensure_node() {
  if command_exists node; then
    node_version=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$node_version" -ge 18 ]; then
      info "Node.js $(node -v) found"
      return
    else
      warn "Node.js $(node -v) found but v18+ is required"
    fi
  fi

  info "installing node.js"
  if command_exists brew; then
    brew install node
  elif command_exists apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command_exists dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo dnf install -y nodejs
  elif command_exists yum; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
  elif command_exists pacman; then
    sudo pacman -S --noconfirm nodejs npm
  elif command_exists apk; then
    sudo apk add nodejs npm
  else
    error "couldn't install node.js, please install from the website itself."
  fi

  command_exists node || error "node.js installation failed. Install manually from https://nodejs.org"
  info "Node.js $(node -v) installed"
}

# install yoinks
install_yoinks() {
  info "Installing yoinks..."
  npm install -g yoinks 2>/dev/null || {
    warn "Global install failed, trying with sudo..."
    sudo npm install -g yoinks
  }

  if command_exists yoinks; then
    info "yoinks installed successfully!"
  else
    warn "npm global bin not in PATH. Adding it..."
    npm bin -g >> "$HOME/.bashrc" 2>/dev/null || true
    npm bin -g >> "$HOME/.zshrc" 2>/dev/null || true
    export PATH="$(npm bin -g):$PATH"
    command_exists yoinks || error "Installation failed. Try: npm install -g yoinks"
  fi
}

# main
main() {
  echo ""
  info "Installing yoinks — yoink any video"
  echo ""
  detect_os
  ensure_node
  install_yoinks
  echo ""
  info "Done! Run 'yoinks' to start downloading."
  info "Example: yoinks https://youtu.be/dQw4w9WgXcQ"
  echo ""
}

main
