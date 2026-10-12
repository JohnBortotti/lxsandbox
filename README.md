# lxsandbox

A thin CLI over [LXD](https://canonical.com/lxd) for running coding agents (Claude Code, Codex) in
bypass mode inside disposable sandboxes on a Linux host. It's one bash script, `lxsandbox`, usually called through its alias `lxs`.

- **Fast:** boxes are LXD system containers cloned from a golden snapshot (a few seconds on btrfs).
- **Batteries included:** git, gh, Node/pnpm, Python/uv, build tools, Chromium, nested Docker, tmux.
- **Log in once:** Claude and Codex accounts are set up on the host and reused by every box.
- **Envs:** named presets (accounts, MCP server, secrets, default repos, setup script).
- **Many repos and many agents per box:** each agent runs in its own tmux session you can drive from scripts.
- **Safe deletes:** `lxs rm` refuses while any repo in the box has unpushed work.

## Requirements
- Linux with LXD (`snap install lxd && lxd init`), a btrfs or zfs storage pool recommended.
- `jq`, `git`, `gh` (optional), and `claude` / `codex` installed on the host (their binaries are copied into boxes).
- If Docker runs on the host, its `FORWARD DROP` policy blocks LXD bridge traffic; see
  `host/lxd-docker-forward.service`.

## Quick start
    ln -s "$PWD/lxsandbox" ~/.local/bin/lxsandbox
    ln -s "$PWD/lxsandbox" ~/.local/bin/lxs           # short alias
    lxs image build                                   # golden container + snapshot (once)
    lxs account claude personal                       # claude setup-token, stored for boxes
    lxs account codex personal                        # codex login into its own CODEX_HOME
    lxs env new web --claude personal --codex personal --repo owner/web-app
    lxs new w1 --env web --repo owner/api             # repos land in /work on branch box/w1
    lxs run w1 claude --name main "read the repo and summarize it"
    lxs logs w1 main; lxs send w1 main "now run the tests"; lxs attach w1 main

## Concepts
- **Golden:** container `lxsandbox-golden`, snapshot `base` (Debian trixie by default, `LXSANDBOX_IMAGE` to change).
  `image/provision.sh` installs the tooling; `lxs image refresh-cli` updates claude/codex.
- **Account** (`~/.lxsandbox/accounts/`): Claude uses a long-lived `claude setup-token` token, exported as
  `CLAUDE_CODE_OAUTH_TOKEN`. Codex uses one `CODEX_HOME` per account, mounted into boxes so token
  refreshes are shared.
- **Env** (`~/.lxsandbox/envs/<env>/`): `env.conf`, `secrets.env` (exported inside the box), `setup.sh`
  (runs after repos are cloned).
- **Box:** repos are bundled on the host (so private repos clone with your host credentials) into
  `/work/<repo>` on branch `box/<box>`, with `origin` pointing at the original remote.
- **Session:** `lxs run` starts `claude --dangerously-skip-permissions` or
  `codex --dangerously-bypass-approvals-and-sandbox` in tmux as user `agent`.

## Git and GitHub (`GITHUB=host`, the default; `--no-github` to opt out)
- The host key (`LXSANDBOX_SSH_KEY`, default `~/.ssh/id_ed25519`) is loaded into a dedicated ssh-agent;
  boxes get only its socket, so agents can push while the box runs but never copy the key.
- `~/.config/gh` is mounted read-only, so `gh pr create` works. The gh token is readable inside the box.
- Remote hostnames without a dot (e.g. tailnet MagicDNS names) are pinned into the box's `/etc/hosts`.
- After a host reboot the ssh-agent comes back with the next `lxs start` or `lxs new`.

## MCP servers (`--mcp HOOK[:SCOPE]`)
A hook is an executable in `~/.lxsandbox/hooks/` that mints a credential per box and revokes it when the
box is deleted, so every box has its own revocable token. See `examples/mcp-hook`. The server is
added to Claude Code and Codex in the box; a `127.0.0.1` url on the host is forwarded into the box.

## Deleting
- `lxs rm <box>` refuses if any `/work` repo has unpushed commits or uncommitted files (`--force` overrides).
- `lxs prune` lists boxes with no agent sessions and nothing unsaved; `lxs prune --yes` deletes them.

## Security notes
Boxes are unprivileged system containers sharing the host kernel, with nesting enabled for Docker.
That is weaker isolation than a VM. Anything given to a box (Claude token, MCP token, secrets.env,
the gh token, use of the ssh-agent) is usable by the agents in it, and by anything that prompt-injects
them. Network egress is open. Give each env only what it needs.

## TODO
- Per-env network allowlist (egress proxy).
- VM boxes (`lxc launch --vm`) where hardware virtualization is available.
- An MCP server exposing `lxs` so other agents get typed tools.

## License
MIT, see `LICENSE`.
