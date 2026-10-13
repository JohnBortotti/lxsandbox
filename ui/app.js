// lxsandbox web UI. Everything here calls the server, which runs the matching lxs command.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

let S = null;                       // last /api/state
const view = { box: null, session: null, tab: "term" };
let term = null;                    // { box, session, xterm, ws, fit, ro }
let logTimer = null;

// ---------- api ----------
async function api(path, body) {
  const r = await fetch(path, body ? {
    method: "POST", headers: { "Content-Type": "application/json", "X-Lxs": "1" }, body: JSON.stringify(body),
  } : {});
  if (r.status === 401) { location.reload(); throw new Error("not logged in"); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || `HTTP ${r.status}`);
  return data;
}
function toast(msg, err) {
  const t = h(`<div class="toast ${err ? "err" : ""}">${esc(msg)}</div>`);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}
async function act(body, okMsg) {
  try { const r = await api("/api/action", body); if (okMsg) toast(okMsg); refresh(); return r; }
  catch (e) { toast(e.message, true); throw e; }
}

// ---------- time ----------
function ago(s) {
  if (!s) return "";
  const d = (Date.now() - new Date(s.replace(" ", "T") + (S?.tz || "")).getTime()) / 1000;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.round((d % 3600) / 60)}m`;
  return `${Math.floor(d / 86400)}d`;
}
const STATE_WORD = { working: "working", idle: "idle", waiting: "needs you", exited: "exited", unknown: "unknown" };

// ---------- state polling ----------
async function refresh() {
  try { S = await api("/api/state"); }
  catch (e) { S = S || { error: e.message, boxes: [], envs: [], accounts: [] }; }
  render();
}
let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => { if (!document.hidden) await refresh(); poll(); }, 3000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

// ---------- routing: #/  ·  #/box/<box>[/<tab>[/<session>]] ----------
let panelKey = null;                // what the panel shows: tab|session|box state
function route() {
  const [, kind, box, tab, session] = location.hash.split("/");
  const prev = view.box;
  if (kind === "box" && box) {
    const b = decodeURIComponent(box);
    if (b !== prev) { closeTerm(); view.session = null; }
    view.box = b;
    view.tab = ["term", "logs", "diff"].includes(tab) ? tab : "term";
    if (session) view.session = decodeURIComponent(session);
  } else { closeTerm(); view.box = null; }
  if (view.box && view.box === prev && $(".box-page")) return render();  // same box: only the panel may change
  $("#main").innerHTML = ""; panelKey = null;
  render();
}
const go = (box, tab = view.tab, s = view.session) =>
  { location.hash = `#/box/${encodeURIComponent(box)}/${tab}${s ? "/" + encodeURIComponent(s) : ""}`; };
window.addEventListener("hashchange", route);

// ---------- render ----------
function render() {
  if (!S) return;
  renderSide();
  if (view.box) renderBox(); else renderHome();
}

function renderSide() {
  const byEnv = {};
  for (const b of S.boxes || []) (byEnv[b.env] = byEnv[b.env] || []).push(b);
  const envs = Object.keys(byEnv).sort();
  $("#boxList").innerHTML = envs.length ? envs.map((e) => `<div class="env-group">${esc(e)}</div>` + byEnv[e].map((b) => {
    const n = (b.sessions || []).length;
    const top = topState(b);
    return `<a class="box-item ${b.box === view.box ? "active" : ""}" href="#/box/${esc(b.box)}">
      <span class="dot ${b.state === "RUNNING" ? (top || "RUNNING") : ""}"></span><span class="name">${esc(b.box)}</span>
      ${n ? `<span class="badge">${n}</span>` : ""}</a>`;
  }).join("")).join("") : `<div class="muted pad" style="font-size:12px">No boxes yet.</div>`;
  const acc = (S.accounts || []).map((a) => `${a.agent}:${a.account}`).join(", ") || "none";
  $("#sysInfo").innerHTML = S.error ? `<div style="color:var(--red)">${esc(S.error)}</div>` : `
    <div class="kv"><span>golden image</span><span>${esc(S.golden)}</span></div>
    <div class="kv"><span>egress proxy</span><span>${esc(S.egress_proxy)}</span></div>
    <div class="kv"><span>accounts</span><span title="${esc(acc)}">${(S.accounts || []).length}</span></div>`;
}
function topState(b) { // the state that most deserves attention
  const st = (b.sessions || []).map((s) => s.state);
  return ["waiting", "working", "idle"].find((x) => st.includes(x)) || "";
}

function renderHome() {
  const boxes = S.boxes || [];
  const sessions = boxes.flatMap((b) => b.sessions || []);
  const count = (x) => sessions.filter((s) => s.state === x).length;
  $("#main").innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Boxes</h1>
      <div class="sub"><span>${boxes.length} box${boxes.length === 1 ? "" : "es"}</span>
        <span>${count("working")} working</span><span>${count("waiting")} need you</span><span>${count("idle")} idle</span></div></div>
      <div class="spacer"></div><button class="btn primary" onclick="openNewBox()">New box</button></div>
    ${boxes.length ? `<div class="grid">${boxes.map(boxCard).join("")}</div>`
      : `<div class="empty">No boxes. Suspiciously tidy.<br><br><button class="btn" onclick="openNewBox()">Create one</button></div>`}
    <div><h2>Envs</h2><div class="card"><table>
      <tr><th>Env</th><th>MCP</th><th>GitHub</th><th>Network</th><th>Allowed hosts</th><th>CPU / memory</th><th>Boxes</th></tr>
      ${(S.envs || []).map((e) => `<tr><td class="mono">${esc(e.env)}</td><td>${esc(e.mcp || "–")}</td><td>${esc(e.github)}</td>
        <td><span class="pill ${esc(e.egress)}">${esc(e.egress)}</span></td>
        <td>${e.egress === "open" ? `<span class="muted">not enforced</span>` : (e.allow || []).length}</td>
        <td>${esc(e.cpu)} / ${esc(e.memory)}</td><td>${(e.boxes || []).length}</td></tr>`).join("")
        || `<tr><td colspan="7" class="muted">No envs (lxs env new &lt;env&gt;)</td></tr>`}
    </table></div></div>
    <div><h2>Accounts</h2><div class="pills">${(S.accounts || []).map((a) =>
      `<span class="pill">${esc(a.agent)} · ${esc(a.account)}</span>`).join("") || `<span class="muted">none</span>`}</div></div>
  </div>`;
}
function boxCard(b) {
  const ss = b.sessions || [];
  return `<a class="card box-card" href="#/box/${esc(b.box)}">
    <div class="title"><span class="dot ${b.state === "RUNNING" ? "RUNNING" : ""}"></span>${esc(b.box)}
      <span class="spacer"></span><span class="pill ${b.egress === "open" ? "open" : ""}">${esc(b.env)}</span></div>
    <div class="pills">${ss.length ? ss.map((s) => `<span class="pill ${esc(s.state)}"><span class="dot ${esc(s.state)}"></span>${esc(s.session)}
      ${s.since ? `<span class="muted">${ago(s.since)}</span>` : ""}</span>`).join("")
      : `<span class="muted" style="font-size:12px">${b.state === "RUNNING" ? "no sessions" : "stopped"}</span>`}</div>
    <div class="meta"><span>${esc(b.egress)} network</span><span>${esc(b.cpu)} cpu · ${esc(b.memory)}</span><span>${esc(b.created)}</span></div>
  </a>`;
}

// ---------- box page ----------
function curBox() { return (S.boxes || []).find((b) => b.box === view.box); }

function renderBox() {
  const b = curBox();
  const main = $("#main");
  if (!b) {
    closeTerm();
    main.innerHTML = `<div class="page"><div class="empty">No box named <b>${esc(view.box)}</b>.<br><br><a class="btn" href="#/">All boxes</a></div></div>`;
    return;
  }
  const ss = b.sessions || [];
  if (!view.session || !ss.find((s) => s.session === view.session)) view.session = ss[0]?.session || null;
  if (!$(".box-page", main)) {
    main.innerHTML = `<div class="page box-page">
      <div class="page-head" id="boxHead"></div>
      <div><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Sessions</h2></div><div class="sessions" id="sessions"></div></div>
      <div class="card panel"><div class="tabs" id="tabs"></div><div class="panel-body" id="panelBody"></div></div>
    </div>`;
    panelKey = null;
  }
  const running = b.state === "RUNNING";
  $("#boxHead").innerHTML = `<div><h1 class="row"><span class="dot ${running ? "RUNNING" : ""}"></span>${esc(b.box)}</h1>
      <div class="sub"><span class="pill">${esc(b.env)}</span><span class="pill ${b.egress === "open" ? "open" : ""}">${esc(b.egress)} network</span>
        <span>${esc(b.cpu)} cpu · ${esc(b.memory)}</span><span>created ${esc(b.created)}</span></div></div>
    <div class="spacer"></div>
    ${running ? `<button class="btn primary" onclick="openRun()">Run agent</button>` : ""}
    <button class="btn" onclick="startStop(this, '${running ? "stop" : "start"}')">${running ? "Stop" : "Start"}</button>
    <button class="btn danger" onclick="openRm()">Delete</button>`;
  renderSessions(b);
  renderTabs();
  const key = `${view.tab}|${view.session}|${b.state}`;
  if (key !== panelKey) { panelKey = key; renderPanel(); }
}

function renderSessions(b) {
  const box = $("#sessions");
  const ss = b.sessions || [];
  if (!ss.length) {
    box.innerHTML = `<div class="empty">${b.state === "RUNNING" ? `No agents running. <br><br><button class="btn" onclick="openRun()">Run one</button>` : "The box is stopped."}</div>`;
    return;
  }
  box.querySelector(".empty")?.remove();
  const seen = new Set();
  for (const s of ss) {
    seen.add(s.session);
    let el = box.querySelector(`[data-s="${CSS.escape(s.session)}"]`);
    if (!el) {
      el = h(`<div class="card sess" data-s="${esc(s.session)}">
        <div class="head"><span class="dot"></span><b></b><span class="pill st"></span><span class="info"></span><span class="spacer"></span>
          <button class="btn sm ghost" data-a="term">Terminal</button><button class="btn sm ghost" data-a="logs">Logs</button>
          <button class="btn sm ghost danger" data-a="kill">End</button></div>
        <div class="reply hidden" title="Click to expand"></div>
        <form class="send"><textarea rows="1" placeholder="Message ${esc(s.session)}…  (Enter sends, Shift+Enter for a new line)"></textarea>
          <button class="btn" type="submit">Send</button></form>
      </div>`);
      el.querySelector("b").textContent = s.session;
      el.addEventListener("click", (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "term" || a === "logs") go(view.box, a, s.session);
        if (a === "kill" && confirm(`End session ${s.session}? The agent stops; the box and its files stay.`))
          act({ op: "kill", box: view.box, session: s.session }, `ended ${s.session}`);
        if (e.target.closest(".reply")) e.target.closest(".reply").classList.add("open");
      });
      const ta = el.querySelector("textarea");
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.querySelector("form").requestSubmit(); } });
      ta.addEventListener("input", () => { ta.style.height = "36px"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; });
      el.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = ta.value; if (!text.trim()) return;
        ta.disabled = true;
        try { await act({ op: "send", box: view.box, session: s.session, text }, `sent to ${s.session}`); ta.value = ""; ta.style.height = "36px"; }
        finally { ta.disabled = false; ta.focus(); }
      });
      box.append(el);
    }
    el.classList.toggle("selected", s.session === view.session);
    el.querySelector(".dot").className = `dot ${s.state}`;
    const st = el.querySelector(".st"); st.className = `pill st ${s.state}`; st.textContent = STATE_WORD[s.state] || s.state;
    el.querySelector(".info").textContent = [s.since && `${s.state === "working" ? "for" : "since"} ${ago(s.since)}`, s.running,
      s.attached ? "attached" : ""].filter(Boolean).join(" · ");
    const r = el.querySelector(".reply");
    if (s.message && s.state !== "working") { if (r.textContent !== s.message) r.textContent = s.message; r.classList.remove("hidden"); }
    else r.classList.add("hidden");
  }
  for (const el of box.querySelectorAll("[data-s]")) if (!seen.has(el.dataset.s)) el.remove();
}

function renderTabs() {
  const ss = curBox()?.sessions || [];
  const tab = (id, label) => `<button class="tab ${view.tab === id ? "active" : ""}" onclick="go(view.box, '${id}')">${label}</button>`;
  const pick = view.tab !== "diff" && ss.length > 1 ? `<select style="width:auto;padding:3px 8px" onchange="go(view.box, view.tab, this.value)">
      ${ss.map((s) => `<option ${s.session === view.session ? "selected" : ""}>${esc(s.session)}</option>`).join("")}</select>` : "";
  const right = view.tab === "term" && view.session ? `${pick}<span>tmux · ${esc(view.session)}</span>`
    : view.tab === "logs" ? `${pick}<button class="btn sm" onclick="loadLogs()">Refresh</button>` : "";
  $("#tabs").innerHTML = tab("term", "Terminal") + tab("logs", "Logs") + tab("diff", "Changes") + `<div class="right">${right}</div>`;
}

function renderPanel() {
  clearInterval(logTimer);
  const body = $("#panelBody");
  const b = curBox();
  if (view.tab !== "term") closeTerm();
  if (view.tab === "term") {
    if (!b || b.state !== "RUNNING" || !view.session) { closeTerm(); body.innerHTML = `<div class="pad muted">No session to attach to.</div>`; return; }
    if (term && term.box === view.box && term.session === view.session && $(".term-wrap", body)) return;
    openTerm(body);
  } else if (view.tab === "logs") {
    if (!view.session) { body.innerHTML = `<div class="pad muted">No session.</div>`; return; }
    body.innerHTML = `<pre class="logs" id="logs">Loading…</pre>`;
    loadLogs(true);
    logTimer = setInterval(() => { if (!document.hidden) loadLogs(); }, 4000);
  } else {
    body.innerHTML = `<div class="pad muted">Looking at the repos in /work…</div>`;
    loadDiff();
  }
}
async function loadLogs(scroll) {
  const pre = $("#logs"); if (!pre) return;
  const atEnd = scroll || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  try {
    const t = await api(`/api/logs?box=${encodeURIComponent(view.box)}&s=${encodeURIComponent(view.session)}&n=400`);
    pre.textContent = t.replace(/\s+$/, "") || "(empty screen)";
  } catch (e) { pre.textContent = e.message; }
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}
async function loadDiff() {
  const body = $("#panelBody");
  if (curBox()?.state !== "RUNNING") { body.innerHTML = `<div class="pad muted">Start the box to see its changes.</div>`; return; }
  try {
    const repos = await api(`/api/diff?box=${encodeURIComponent(view.box)}`);
    if (view.tab !== "diff") return;
    body.innerHTML = !repos.length ? `<div class="pad muted">No repos in /work.</div>` : `<table>
      <tr><th>Repo</th><th>Branch</th><th>Commits</th><th>Unpushed</th><th>Uncommitted</th><th>Changes</th><th>PR</th><th></th></tr>
      ${repos.map((r) => `<tr><td class="mono">${esc(r.repo)}</td><td class="mono">${esc(r.branch)}</td><td>${r.commits}</td>
        <td>${r.unpushed ? `<span class="pill waiting">${r.unpushed}</span>` : "0"}</td>
        <td>${r.uncommitted ? `<span class="pill waiting">${r.uncommitted}</span>` : "0"}</td>
        <td>${esc(r.changes || "–")}</td>
        <td>${r.pr ? `<a href="${esc(r.pr)}" target="_blank" rel="noopener">${esc(r.pr.replace(/^https:\/\/github\.com\//, ""))}</a>` : "–"}</td>
        <td><button class="btn sm" onclick="loadPatch('${esc(r.repo)}')">View diff</button></td></tr>`).join("")}
    </table><div id="patch"></div>`;
  } catch (e) { body.innerHTML = `<div class="pad" style="color:var(--red)">${esc(e.message)}</div>`; }
}
async function loadPatch(repo) {
  const el = $("#patch"); el.innerHTML = `<div class="pad muted">Loading ${esc(repo)}…</div>`;
  try {
    const t = await api(`/api/patch?box=${encodeURIComponent(view.box)}&repo=${encodeURIComponent(repo)}`);
    if (!t.trim()) { el.innerHTML = `<div class="pad muted">No changes against the base branch.</div>`; return; }
    const lines = t.split("\n").slice(0, 8000);
    el.innerHTML = `<div class="diff">${lines.map((l) => {
      const c = l.startsWith("diff --git") || l.startsWith("untracked:") ? "file" : l.startsWith("@@") ? "hunk"
        : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
      return `<div class="${c}">${esc(l) || " "}</div>`;
    }).join("")}</div>`;
  } catch (e) { el.innerHTML = `<div class="pad" style="color:var(--red)">${esc(e.message)}</div>`; }
}

// ---------- live terminal ----------
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function openTerm(body) {
  closeTerm();
  body.innerHTML = `<div class="term-wrap"><div id="xt" style="height:100%"></div></div>`;
  const xterm = new Terminal({
    fontFamily: cssVar("--mono"), fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: cssVar("--term-bg"), foreground: cssVar("--term-fg"), cursor: cssVar("--term-fg"),
      selectionBackground: "rgba(127,127,127,.3)" },
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open($("#xt"));
  fit.fit();
  const t = term = { box: view.box, session: view.session, xterm, fit, ws: null, ro: null };
  const connect = () => {
    $(".term-wrap .overlay")?.remove();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = t.ws = new WebSocket(`${proto}://${location.host}/api/term?box=${encodeURIComponent(t.box)}&s=${encodeURIComponent(t.session)}&cols=${xterm.cols}&rows=${xterm.rows}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => xterm.write(new Uint8Array(e.data));
    ws.onclose = () => {
      if (term !== t) return;
      const o = h(`<div class="overlay"><div class="row"><span class="muted">Detached from ${esc(t.session)}.</span>
        <button class="btn sm">Reconnect</button></div></div>`);
      o.querySelector("button").onclick = connect;
      $(".term-wrap")?.append(o);
    };
  };
  xterm.onData((d) => t.ws?.readyState === 1 && t.ws.send("0" + d));
  xterm.onResize(({ cols, rows }) => t.ws?.readyState === 1 && t.ws.send("1" + JSON.stringify({ cols, rows })));
  t.ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  t.ro.observe($(".term-wrap"));
  connect();
  xterm.focus();
}
function closeTerm() {
  if (!term) return;
  const t = term; term = null;
  t.ro?.disconnect(); try { t.ws?.close(); } catch {} t.xterm.dispose();
}

// ---------- dialogs ----------
document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

function openNewBox() {
  const d = $("#newBoxDlg"), f = $("#newBoxForm");
  f.reset(); $(".job", f).classList.add("hidden"); $("button[type=submit]", f).disabled = false;
  f.env.innerHTML = (S.envs || []).map((e) => `<option value="${esc(e.env)}">${esc(e.env)} · ${esc(e.egress)} network${e.mcp ? " · MCP " + esc(e.mcp) : ""}</option>`).join("");
  d.showModal(); f.box.focus();
}
$("#newBoxBtn").addEventListener("click", openNewBox);
$("#newBoxForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $(".job", f), btn = $("button[type=submit]", f);
  const box = f.box.value.trim();
  btn.disabled = true; out.classList.remove("hidden"); out.textContent = `lxs new ${box} --env ${f.env.value}…\n`;
  try {
    const { job } = await api("/api/action", { op: "new", box, env: f.env.value, repos: f.repos.value.split("\n") });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const j = await api(`/api/job?id=${job}`);
      out.textContent = j.cmd + "\n" + j.out; out.scrollTop = out.scrollHeight;
      if (j.done) {
        if (j.rc === 0) { toast(`box ${box} ready`); $("#newBoxDlg").close(); await refresh(); go(box, "term", null); }
        else btn.disabled = false;
        return;
      }
    }
  } catch (err) { out.textContent += "\n" + err.message; btn.disabled = false; }
});

function openRun() {
  const d = $("#runDlg"), f = $("#runForm");
  f.reset(); $("[data-box]", d).textContent = view.box;
  const fill = () => {
    const kind = f.agent.value;
    const accs = (S.accounts || []).filter((a) => a.agent === kind);
    f.account.innerHTML = accs.map((a) => `<option>${esc(a.account)}</option>`).join("") || `<option value="">no ${kind} account</option>`;
  };
  f.querySelectorAll("[name=agent]").forEach((r) => (r.onchange = fill));
  fill();
  const used = new Set((curBox()?.sessions || []).map((s) => s.session));
  f.name.value = used.has("main") ? "" : "main";
  d.showModal(); f.prompt.focus();
}
$("#runForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, btn = $("button[type=submit]", f);
  btn.disabled = true;
  try {
    const r = await act({ op: "run", box: view.box, agent: f.agent.value, account: f.account.value, name: f.name.value.trim(),
      prompt: f.prompt.value, continue: f.continue.checked });
    $("#runDlg").close();
    const s = (r.output || "").trim() || f.name.value.trim();
    toast(`started ${s}`);
    await refresh(); go(view.box, "term", s);
  } catch {} finally { btn.disabled = false; }
});

function openRm() {
  const d = $("#rmDlg"), f = $("#rmForm");
  f.reset(); f.dataset.force = ""; $("[data-box]", d).textContent = view.box; $(".dirty", f).classList.add("hidden");
  d.showModal();
}
$("#rmForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, btn = $("button[type=submit]", f), box = view.box, force = !!f.dataset.force;
  if (force && f.confirm.value !== box) { toast("type the box name to confirm", true); return; }
  btn.disabled = true; btn.textContent = "Deleting…";
  try {
    await api("/api/action", { op: "rm", box, force });
    $("#rmDlg").close(); toast(`deleted ${box}`); closeTerm(); location.hash = "#/"; refresh();
  } catch (err) {
    if (/unsaved work/.test(err.message)) {
      f.dataset.force = "1"; $(".dirty", f).classList.remove("hidden"); $(".dirty pre", f).textContent = err.message;
      btn.textContent = "Delete anyway"; f.confirm.focus();
    } else toast(err.message, true);
  } finally { btn.disabled = false; if (!f.dataset.force) btn.textContent = "Delete"; }
});

async function startStop(btn, op) {
  btn.disabled = true; btn.textContent = op === "stop" ? "Stopping…" : "Starting…";
  if (op === "stop") closeTerm();
  try { await act({ op, box: view.box }, `${op === "stop" ? "stopped" : "started"} ${view.box}`); } catch {}
}

route();
refresh().then(poll);
