const $ = (id) => document.getElementById(id);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (ts) => new Date(ts * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const pill = (s, cls) => `<span class="pill ${cls || esc(String(s).split(" ")[0])}">${esc(s)}</span>`;

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(kind, msg, sub = "") {
  const t = $("toast");
  t.className = `show ${kind}`;
  t.innerHTML = esc(msg) + (sub ? `<small>${esc(sub)}</small>` : "");
  clearTimeout(t.timer);
  if (kind !== "wait") t.timer = setTimeout(() => (t.className = ""), 4500);
}
const onChain = (r) => `Recorded on the blockchain · block ${r.block} · tx ${short(r.tx)}`;

// Runs a blockchain action with progress, result and error messages.
async function act(label, path, body, done) {
  toast("wait", `${label}…`, "Waiting for the blockchain");
  try {
    const r = await api(path, body);
    toast("ok", `${label}: done`, onChain(r));
    if (done) await done(r);
    return r;
  } catch (e) {
    toast("bad", `${label}: rejected`, e.message);
  }
}

let ME;
async function layout(active) {
  ME = (await api("me")).user;
  const portal = ME ? { patient: "/patient", doctor: "/doctor", admin: "/admin" }[ME.role] : null;
  document.body.insertAdjacentHTML("afterbegin", `<header class="top"><a class="brand" href="/">Medi<span>Link</span></a><nav>
    <a href="/" class="${active === "home" ? "on" : ""}">Home</a>
    ${ME ? `<a href="${portal}" class="${active === "portal" ? "on" : ""}">My portal</a><span class="who">${esc(ME.name)}</span><a href="#" id="signout">Sign out</a>`
         : `<a href="/signin" class="${active === "signin" ? "on" : ""}">Sign in</a><a href="/signup" class="${active === "signup" ? "on" : ""}">Sign up</a>`}
  </nav></header>`);
  document.body.insertAdjacentHTML("beforeend", `<div id="toast"></div>`);
  $("signout")?.addEventListener("click", async (e) => { e.preventDefault(); await api("signout", {}); location.href = "/"; });
  return ME;
}

function requireRole(role) {
  if (!ME || ME.role !== role) { location.href = `/signin?next=${location.pathname}`; return false; }
  return true;
}

// Refreshes the page whenever anything changes on the blockchain.
function live(refresh) {
  let timer;
  const es = new EventSource("/api/stream");
  es.onmessage = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); };
}
