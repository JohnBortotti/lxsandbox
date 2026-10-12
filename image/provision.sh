#!/usr/bin/env bash
# Runs as root INSIDE the golden container. Idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99ipv4  # lxdbr0 is IPv4-only

apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl wget git git-lfs openssh-client sudo tmux less vim-tiny \
  ripgrep fd-find jq unzip zip xz-utils procps iproute2 dnsutils \
  build-essential pkg-config python3 python3-venv python3-pip pipx \
  nodejs npm gh docker.io docker-cli docker-compose fuse-overlayfs \
  chromium fonts-liberation fonts-noto-color-emoji postgresql-client

# agent user: uid 1000, passwordless sudo inside the box only, docker group
if ! id agent >/dev/null 2>&1; then
  old=$(getent passwd 1000 | cut -d: -f1 || true)
  if [ -n "$old" ]; then  # cloud images ship a uid-1000 user (debian/ubuntu): rename it
    usermod -l agent -d /home/agent -m "$old"; groupmod -n agent "$(id -gn agent)" 2>/dev/null || true
  else useradd -m -u 1000 -s /bin/bash agent; fi
fi
usermod -aG docker,sudo agent
echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 440 /etc/sudoers.d/agent
systemctl enable docker >/dev/null 2>&1 || true

# node tooling
corepack enable >/dev/null 2>&1 || npm i -g pnpm
sudo -u agent bash -lc 'pipx install uv >/dev/null 2>&1 || true; pipx ensurepath >/dev/null'

# Chromium for headless/Playwright use (PLAYWRIGHT uses system chromium via this path)
echo 'export CHROME_PATH=/usr/bin/chromium PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium' > /etc/profile.d/chromium.sh

# per-box secrets/tokens written by `lxs new` into ~/.boxenv; load them in every login shell
echo '[ -f "$HOME/.boxenv" ] && . "$HOME/.boxenv"' > /etc/profile.d/boxenv.sh

mkdir -p /work && chown agent:agent /work
apt-get clean
