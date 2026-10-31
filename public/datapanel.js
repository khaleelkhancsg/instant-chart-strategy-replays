// The Data panel: the store's commands as buttons. The server runs them (src/datajobs.mjs) and
// the page shows what they say. What the status means is worked out in ui.mjs.

import { dataNotes, heldRows, compareText, jobText, guessCsv, fmtBytes } from "/ui.mjs";

const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, code: r.status, ...(await r.json()) })).catch((e) => ({ ok: false, error: e.message }));
const cell = (tag, text, className = "") => Object.assign(document.createElement(tag), { textContent: text, className });
const HEADS = ["Source", "Bars", "Held", "Contracts", "From (UTC)", "To (UTC)"], RIGHT = [2, 3];
const row = (tag, cells) => { const tr = document.createElement("tr"); tr.append(...cells.map((c, k) => cell(tag, c, RIGHT.includes(k) ? "r" : ""))); return tr; };

export function initDataPanel() {
  const panel = $("dataPanel"), buttons = ["dpPull", "dpAdd", "dpBuild", "dpBackup", "dpAddGo", "dpAddCancel"].map($);
  let status = null, following = false, file = null, reads = 0;
  const isOpen = () => !panel.classList.contains("hidden");
  const busy = (on) => { for (const b of buttons) b.disabled = on; $("dpBusy").textContent = on ? "Working…" : ""; };
  const log = (text) => { const el = $("dpLog"); el.textContent = text; el.scrollTop = el.scrollHeight; };

  function render(s) {
    status = s;
    $("dpNotes").replaceChildren(...dataNotes(s, Date.now()).map((n) => cell("div", n.text, `dp-note ${n.level}`)));
    const rows = heldRows(s.sources || []);
    $("dpSources").replaceChildren(...(rows.length ? [row("th", HEADS), ...rows.map((r) => row("td", r))] : []));
    $("dpCompare").textContent = compareText(s.compare || []);
    $("dpWhere").textContent = s.database ? `${s.database}, ${Number(s.megabytes).toLocaleString("en-US")} MB` : "";
    if (document.activeElement !== $("dpFolder")) $("dpFolder").value = s.backupDir || "";
    $("dpCloud").classList.toggle("hidden", !s.cloudFolder || s.cloudFolder === s.backupDir);
  }
  // Only the latest read is shown: an older one could land last and show what is no longer true.
  async function refresh() {
    if (!status) $("dpNotes").replaceChildren(cell("div", "Reading the store…", "dp-note"));
    const mine = ++reads, s = await fetch("/api/data/status").then((r) => r.json()).catch((e) => ({ error: e.message }));
    if (mine === reads) render(s);
  }

  // While a command runs its output comes in here, and the panel can close and reopen meanwhile.
  async function follow() {
    if (following) return;
    following = true;
    busy(true);
    for (;;) {
      const job = await fetch("/api/data/job").then((r) => r.json()).catch(() => null);
      if (!job) { log("Lost touch with the server, so the end of this command was not seen."); break; }
      if (!job.id) { log("The server restarted, so the end of this command was not seen."); break; }
      log(jobText(job));
      if (!job.running) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    following = false;
    busy(false);
    if (isOpen()) await refresh();
  }
  async function run(command) {
    log("");
    const r = await post("/api/data/run", { command });
    if (!r.ok && r.code !== 409) return log(r.error);
    follow();
  }

  // ── a CSV from this computer ──
  function chooseFile(f) {
    file = f;
    const g = guessCsv(f.name);
    $("dpFileName").textContent = `${f.name}, ${fmtBytes(f.size)}`;
    $("dpSource").value = g.source; $("dpMinutes").value = String(g.minutes);
    $("dpAddForm").classList.remove("hidden");
  }
  function send() {
    const q = new URLSearchParams({ name: file.name, source: $("dpSource").value, minutes: $("dpMinutes").value }), x = new XMLHttpRequest();
    busy(true);
    log(`Sending ${file.name}…`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) log(`Sending ${file.name}: ${Math.round((100 * e.loaded) / e.total)}%`); };
    x.onload = () => {
      busy(false);
      $("dpAddForm").classList.add("hidden");
      if (x.status === 202) follow();
      else { try { log(JSON.parse(x.responseText).error); } catch { log(`The upload failed (${x.status})`); } }
    };
    x.onerror = () => { busy(false); log("The upload failed."); };
    x.open("POST", `/api/data/upload?${q}`);
    x.send(file);
  }

  async function saveFolder(dir) {
    const r = await post("/api/data/backup-folder", { dir });
    log(r.ok ? `Backups will go to ${r.backupDir}` : r.error);
    if (r.ok) { $("dpFolder").value = r.backupDir; await refresh(); }
  }

  function open() {
    panel.classList.remove("hidden");
    refresh();
    fetch("/api/data/job").then((r) => r.json()).then((j) => { if (j.running) follow(); else if (!$("dpLog").textContent) log(jobText(j)); }).catch(() => {});
  }
  const close = () => panel.classList.add("hidden");

  $("dataBtn").onclick = open;
  $("dataClose").onclick = close;
  panel.addEventListener("mousedown", (e) => { if (e.target === panel) close(); });
  $("dpPull").onclick = () => run("pull");
  $("dpBuild").onclick = () => run("build");
  $("dpBackup").onclick = () => run("backup");
  $("dpAdd").onclick = () => { $("dpFile").value = ""; $("dpFile").click(); };
  $("dpFile").onchange = (e) => { if (e.target.files[0]) chooseFile(e.target.files[0]); };
  $("dpAddGo").onclick = send;
  $("dpAddCancel").onclick = () => $("dpAddForm").classList.add("hidden");
  $("dpFolderSave").onclick = () => saveFolder($("dpFolder").value);
  $("dpCloud").onclick = () => status && saveFolder(status.cloudFolder);
  // The chart's single-key shortcuts must not fire behind the panel.
  window.addEventListener("keydown", (e) => { if (!isOpen()) return; if (e.key === "Escape") close(); e.stopImmediatePropagation(); }, true);
}
