# lxsandbox

A thin CLI over [LXD](https://canonical.com/lxd) for running coding agents (Claude Code, Codex) in
bypass mode inside disposable sandboxes on a Linux host. It's one bash script, `lxsandbox`, usually called through its alias `lxs`.

- **Fast:** boxes are LXD system containers cloned from a golden snapshot (a few seconds on btrfs).
- **Batteries included:** git, gh, Node/pnpm, Python/uv, build tools, Chromium, nested Docker, tmux.
- **Log in once:** Claude and Codex accounts are set up on the host and reused by every box.
- **Envs:** named presets (MCP server, network allowlist, GitHub access, secrets, setup script); repos and accounts are picked per box and per session.
- **Many repos and many agents per box:** each agent runs in its own tmux session you can drive from scripts.
- **Safe deletes:** `lxs rm` refuses while any repo in the box has unpushed work.
- **Network allowlist per env:** boxes reach only the hosts their env allows, editable live.

## Requirements
- Linux with LXD (`snap install lxd && lxd init`), a btrfs or zfs storage pool recommended.
- `jq`, `git`, `python3` (for the egress proxy), `gh` (optional), and `claude` / `codex` installed on the host
  (their binaries are copied into boxes).
- If Docker runs on the host, its `FORWARD DROP` policy blocks LXD bridge traffic; see
  `host/lxd-docker-forward.service`.

## Quick start
    ln -s "$PWD/lxsandbox" ~/.local/bin/lxsandbox
    ln -s "$PWD/lxsandbox" ~/.local/bin/lxs           # short alias
    lxs image build                                   # golden container + snapshot (once)
    lxs account claude personal                       # claude setup-token, stored for boxes
    lxs account codex personal                        # codex login into its own CODEX_HOME
    lxs env new web                                   # MCP, network and secrets live in the env
    lxs new w1 --env web --repo owner/api             # repos land in /work on branch box/w1
    lxs run w1 claude --account personal --name main "read the repo and summarize it"
    lxs wait w1 main                                  # blocks until the turn ends, prints the reply
    lxs logs w1 main; lxs send w1 main "now run the tests"; lxs attach w1 main

`lxs wait` exits 0 when the agent finished its turn, 2 when it's waiting for an answer, 3 when the
session is gone, 124 on `--timeout`. It reads Claude Code hooks that `lxs new` installs in the box,
so `lxs ps` also shows each session as working / idle / waiting. Bots use it instead of polling `logs`.

## Concepts
- **Golden:** container `lxsandbox-golden`, snapshot `base` (Debian trixie by default, `LXSANDBOX_IMAGE` to change).
  `image/provision.sh` installs the tooling; `lxs image refresh-cli` updates claude/codex.
- **Account** (`~/.lxsandbox/accounts/`): Claude uses a long-lived `claude setup-token` token, exported as
  `CLAUDE_CODE_OAUTH_TOKEN`. Codex uses one `CODEX_HOME` per account, mounted into boxes so token
  refreshes are shared. Accounts are not tied to envs: `lxs run --account` picks one per session, so
  one box can run agents on different accounts (left out when only one account of that kind exists).
- **Run defaults:** an env's `env.conf` can set `CLAUDE_ACCOUNT`, `CLAUDE_MODEL`, `CLAUDE_EFFORT` (and the
  `CODEX_*` equivalents). `lxs run` uses them when `--account`, `--model` or `--effort` is left out, so
  every box of that env starts its agents the same way.
- **Baked bases:** `lxs env bake <env>` builds a base for the env's boxes: it clones `BAKE_REPOS`, runs
  `setup.sh` and `bake.sh` (default: `docker compose pull`/`build` per repo, or `docker build`), then strips
  repos, tokens and proxy credentials. New boxes copy it instead of golden, so docker images and build cache
  are already there. Rebake whenever dependencies change; `lxs env unbake <env>` goes back to golden.
- **Env** (`~/.lxsandbox/envs/<env>/`): `env.conf`, `secrets.env` (exported inside the box), `setup.sh`
  (runs after repos are cloned).
- **Box:** repos are bundled on the host (so private repos clone with your host credentials) into
  `/work/<repo>` on branch `box/<box>`, with `origin` pointing at the original remote.
- **Repo specs** (`lxs new --repo R`, repeatable):
  - `owner/name` → cloned fresh from GitHub with `gh`; a git url (`ssh://…`, `git@host:…`, `https://…`) →
    cloned fresh with `git`. Both always start from the remote's latest state.
  - a path, or a bare name found in `~/workspace/<name>` → your local checkout as it is, including
    local commits and branches that aren't pushed yet (uncommitted changes are not copied).
- **Session:** `lxs run` starts `claude --dangerously-skip-permissions` or
  `codex --dangerously-bypass-approvals-and-sandbox` in tmux as user `agent`.

## Git and GitHub (`GITHUB=host`, the default; `--no-github` to opt out)
- The host key (`LXSANDBOX_SSH_KEY`, default `~/.ssh/id_ed25519`) is loaded into a dedicated ssh-agent;
  boxes get only its socket, so agents can push while the box runs but never copy the key.
- `~/.config/gh` is mounted read-only, so `gh pr create` works. The gh token is readable inside the box.
- Remote hostnames without a dot (e.g. tailnet MagicDNS names) are pinned into the box's `/etc/hosts`.
- After a host reboot the ssh-agent comes back with the next `lxs start` or `lxs new`.

## Network (`EGRESS=allowlist`, the default for new envs; `--egress open` to opt out)
- An allowlist box has **no network interface**. Its only way out is `lxsandbox-egress`, a small HTTP
  proxy on a unix socket on the host, forwarded into the box as `127.0.0.1:3128`. Shells, sudo, apt,
  Docker and ssh (via a `ProxyCommand`) are set up to use it; anything that ignores it simply has no route.
- Each box authenticates with its own token and may reach only the hosts in its env's `egress.allow`,
  plus the origin hosts of its repos. DNS resolves on the host, so tailnet names work if allowed.
- The default list covers Anthropic, OpenAI, GitHub, npm, PyPI and Debian. Edit it from the CLI;
  changes apply to running boxes immediately:

      lxs egress show web
      lxs egress allow web api.stripe.com '*.supabase.co' myhost:8443
      lxs egress remove web pypi.org
      lxs egress log -n 20 --box b1     # ALLOW/DENY per request, to see what a box tried to reach
      lxs egress mode web open          # for boxes created from now on

- `lxs` starts the proxy on demand; `host/lxsandbox-egress.service` keeps it up across reboots.
- Local MCP servers (`127.0.0.1` urls) and the ssh-agent are LXD proxy devices, not network, so they keep working.

## Looking around
`lxs status` shows the golden image, the egress proxy, accounts, envs and boxes at a glance. Listing
commands (`status`, `ls`, `ps`, `env ls|show`, `egress show|log`, `account ls`) print tables on a terminal
and take `--json` for scripts:

    lxs ls --json | jq -r '.[] | select(.state == "RUNNING") | .box'
    lxs env show web --json | jq .allow

`lxs diff <box>` sums up each `/work` repo against its base branch (commits, unpushed, uncommitted,
open PR); `lxs diff <box> <repo>` prints the patch.

## Web UI (`lxs ui`)
A small local web page over the same commands: boxes and their sessions (working / idle / needs you, and
for how long), the last reply, a box to message an agent, a live terminal on its tmux session, logs, the
changes in `/work` with their diff and PR, and buttons for new box, run agent, start/stop and delete (with
the same unsaved-work guard as `lxs rm`). It only calls `lxs`; no extra dependencies beyond python3.

    lxs ui                       # http://127.0.0.1:4791/?token=...

The URL it prints carries a token (kept in `~/.lxsandbox/ui.token`; delete the file and restart to
rotate it), which the page trades for a cookie. It listens on localhost only; to reach it from other
machines put an authenticated proxy in front, e.g. `tailscale serve --bg --https=8444 http://127.0.0.1:4791`.
`host/lxsandbox-ui.service` keeps it running.

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
them. With `EGRESS=allowlist` a box can only talk to the hosts you allowed, but an allowed host can still
receive data (e.g. a gist on github.com). `EGRESS=open` boxes reach everything the host reaches, including
your LAN and tailnet. Give each env only what it needs. The web UI can run commands in every box, so
treat its URL like a shell login.

## TODO
- VM boxes (`lxc launch --vm`) where hardware virtualization is available.
- An MCP server exposing `lxs` so other agents get typed tools.

## License
MIT, see `LICENSE`.
