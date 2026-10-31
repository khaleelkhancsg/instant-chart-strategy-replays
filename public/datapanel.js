// The Data panel: the store's commands as buttons. The server runs them (src/datajobs.mjs) and
// the page shows what they say. What the status means is worked out in ui.mjs.

import { dataNotes, guessCsv, fmtBytes } from "/ui.mjs";

const $ = (id) => document.getElementById(id);
const num = (n) => Number(n).toLocaleString("en-US");
const minute = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, code: r.status, ...(await r.json()) })).catch((e) => ({ ok: false, error: e.message }));

export function initDataPanel() {
  const panel = $("dataPanel"), buttons = ["dpPull", "dpAdd", "dpBuild", "dpBackup", "dpAddGo"].map($);
  let status = null, following = false, file = null;
  const isOpen = () => !panel.classList.contains("hidden");
  const busy = (on) => { for (const b of buttons) b.disabled = on; $("dpBusy").textContent = on ? "Working…" : ""; };
  const log = (text) => { const el = $("dpLog"); el.textContent = text; el.scrollTop = el.scrollHeight; };

  function render(s) {
    status = s;
    const notes = dataNotes(s, Date.now());
    $("dpNotes").replaceChildren(...notes.map((n) => Object.assign(document.createElement("div"), { className: `dp-note ${n.level}`, textContent: n.text })));
    const rows = s.sources || [];
    $("dpSources").innerHTML = rows.length ? `<tr><th>Source</th><th>Bars</th><th class="r">Held</th><th class="r">Contracts</th><th>From (UTC)</th><th>To (UTC)</th></tr>` +
      rows.map((r) => `<tr><td>${r.source}</td><td>${r.minutes}-minute</td><td class="r">${num(r.rows)}</td><td class="r">${r.contracts}</td><td>${minute(r.first)}</td><td>${minute(r.last)}</td></tr>`).join("") : "";
    $("dpCompare").textContent = (s.compare || []).map((c) => `${c.symbol}: ${num(c.both)} minutes in both sources, ${(100 * c.samePrices / c.both).toFixed(1)}% same prices, ${(100 * c.sameVolume / c.both).toFixed(1)}% same volume, worst ${c.worst} points`).join("  ·  ");
    $("dpWhere").textContent = s.database ? `${s.database}, ${num(s.megabytes)} MB` : "";
    if (document.activeElement !== $("dpFolder")) $("dpFolder").value = s.backupDir || "";
    $("dpCloud").classList.toggle("hidden", !s.cloudFolder || s.cloudFolder === s.backupDir);
  }
  async function refresh() {
    if (!status) $("dpNotes").innerHTML = `<div class="dp-note">Reading the store…</div>`;
    render(await fetch("/api/data/status").then((r) => r.json()).catch((e) => ({ error: e.message })));
  }

  // While a command runs its output comes in here, and the panel can close and reopen meanwhile.
  async function follow() {
    if (following) return;
    following = true;
    busy(true);
    let job;
    do {
      job = await fetch("/api/data/job").then((r) => r.json()).catch(() => ({ running: false, lines: ["Lost touch with the server."], exit: 1 }));
      if (job.id) log(`${job.lines.join("\n")}${job.running ? "" : `\n\n${job.label}: ${job.exit === 0 ? "done" : "stopped with an error"}, ${((job.endedAt - job.startedAt) / 1000).toFixed(1)} s`}`);
      if (job.running) await new Promise((r) => setTimeout(r, 400));
    } while (job.running);
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

  function open() { panel.classList.remove("hidden"); refresh(); fetch("/api/data/job").then((r) => r.json()).then((j) => { if (j.running) follow(); else if (j.id && !$("dpLog").textContent) log(j.lines.join("\n")); }).catch(() => {}); }
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
