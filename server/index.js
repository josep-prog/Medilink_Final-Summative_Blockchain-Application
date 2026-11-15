require("dotenv").config({ quiet: true });
require("net").setDefaultAutoSelectFamilyAttemptTimeout(3000);
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const NETWORK = process.env.NETWORK || "localhost";
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "admin@medilink.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@2026";
const HARDHAT_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RPC = NETWORK === "sepolia" ? process.env.SEPOLIA_RPC_URL : "http://127.0.0.1:8545";
const FUND = NETWORK === "sepolia" ? "0.002" : "1";
const STATUS = { slot: ["Open", "Booked", "Held", "Closed"], appt: ["Booked", "Reschedule proposed", "Completed", "Cancelled"], doctor: ["None", "Pending", "Approved", "Removed"] };

const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${NETWORK}.json`)));
const provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 1500 });
const funder = new ethers.Wallet(NETWORK === "sepolia" ? process.env.PRIVATE_KEY : HARDHAT_KEY_0, provider);
const contract = new ethers.Contract(deployment.address, deployment.abi, provider);
const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
// Fingerprint of a patient's confirmed details. A random per-user salt stops anyone
// guessing the details by hashing likely names, ages and phone numbers.
// (Accounts created before salts were added have no salt and keep the old format.)
const detailsHash = (u) => hash(`${u.salt ? u.salt + "|" : ""}${u.name}|${u.age}|${u.phone}|${u.email}`);

// ---------- off-chain store ----------
const DB_FILE = path.join(__dirname, "..", "data", `${NETWORK}.json`);
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : null;
if (!db || db.contract !== deployment.address) db = { contract: deployment.address, users: [], meetings: {} };
const save = () => { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); };
const byEmail = (e) => db.users.find((u) => u.email === e.toLowerCase());
const byAddress = (a) => db.users.find((u) => u.address.toLowerCase() === a.toLowerCase());

// Wallet keys are encrypted with the user's own password.
function seal(secret, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return [salt, iv, c.getAuthTag(), data].map((b) => b.toString("hex")).join(".");
}
function unseal(box, password) {
  const [salt, iv, tag, data] = box.split(".").map((h) => Buffer.from(h, "hex"));
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(password, salt, 32), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

if (!byEmail(ADMIN_EMAIL)) {
  db.users.push({ role: "admin", name: "MediLink Admin", email: ADMIN_EMAIL, address: funder.address, key: seal(funder.privateKey, ADMIN_PASSWORD) });
  save();
}

// ---------- sessions ----------
const sessions = new Map();
function session(req) {
  const sid = (req.headers.cookie || "").match(/sid=([a-f0-9]+)/)?.[1];
  return sid && sessions.get(sid);
}
function auth(role) {
  return (req, res, next) => {
    const s = session(req);
    if (!s || (role && s.user.role !== role)) return res.status(401).json({ error: "Please sign in" + (role ? ` as ${role}` : "") });
    req.s = s;
    next();
  };
}
function startSession(res, user, wallet) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { user, wallet: wallet.connect(provider) });
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
}

// ---------- blockchain helpers ----------
let funderQueue = Promise.resolve();
const nonceOf = async (a) => Number(await provider.send("eth_getTransactionCount", [a, "pending"]));
const fund = (to) => (funderQueue = funderQueue.catch(() => {}).then(async () => (await funder.sendTransaction({ to, value: ethers.parseEther(FUND), nonce: await nonceOf(funder.address) })).wait()));

function reason(e) {
  return e?.reason || e?.info?.error?.message?.replace(/^.*reverted with reason string '(.*)'$/, "$1") || e?.shortMessage || e?.message || "Transaction failed";
}
async function send(wallet, fn, ...args) {
  const run = async () => {
    const tx = await contract.connect(wallet)[fn](...args, { nonce: await nonceOf(wallet.address) });
    const r = await tx.wait();
    return { tx: tx.hash, block: r.blockNumber, logs: r.logs };
  };
  const result = wallet.address === funder.address ? await (funderQueue = funderQueue.catch(() => {}).then(run)) : await run();
  broadcast(fn);
  return result;
}
let deployBlock;
const fromBlock = async () => (deployBlock ??= (await provider.getTransactionReceipt(deployment.txHash))?.blockNumber ?? 0);

async function readAll() {
  const [slotCount, apptCount] = await Promise.all([contract.slotCount(), contract.appointmentCount()]);
  const slots = await Promise.all(Array.from({ length: Number(slotCount) }, (_, i) => contract.getSlot(i + 1)));
  const appts = await Promise.all(Array.from({ length: Number(apptCount) }, (_, i) => contract.getAppointment(i + 1)));
  const docAddrs = [...new Set([...db.users.filter((u) => u.role === "doctor").map((u) => u.address), ...slots.map((s) => s.doctor)])];
  const doctors = {};
  for (const a of docAddrs) {
    const d = await contract.doctors(a);
    doctors[a.toLowerCase()] = { address: a, name: d.name, specialty: d.specialty, licenseNo: d.licenseNo, status: STATUS.doctor[Number(d.status)], email: byAddress(a)?.email };
  }
  const slotView = (s) => ({ id: Number(s.id), doctor: doctors[s.doctor.toLowerCase()], start: Number(s.startTime), status: STATUS.slot[Number(s.status)], appointmentId: Number(s.appointmentId) });
  return {
    doctors,
    slots: slots.map(slotView),
    appts: appts.map((a) => ({
      id: Number(a.id), slot: slotView(slots[Number(a.slotId) - 1]), patient: a.patient, patientName: byAddress(a.patient)?.name,
      doctor: doctors[a.doctor.toLowerCase()], mode: Number(a.mode) === 0 ? "Virtual" : "In-person", status: STATUS.appt[Number(a.status)],
      proposed: Number(a.proposedSlotId) ? slotView(slots[Number(a.proposedSlotId) - 1]) : null, reason: a.reason,
    })),
  };
}

// ---------- live updates ----------
const clients = new Set();
function broadcast(what) {
  for (const c of clients) c.write(`data: ${JSON.stringify({ what, at: Date.now() })}\n\n`);
}

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: reason(e) }));

app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 2000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.post("/api/signup", wrap(async (req, res) => {
  const { role, name, email, password, phone, age, specialty, licenseNo, confirm } = req.body;
  const mail = String(email || "").trim().toLowerCase();
  if (!name || !mail || !password) throw new Error("Name, email and password are required");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  if (byEmail(mail)) throw new Error("This email is already registered");
  const staff = mail.endsWith("@medilink.com");
  if (role === "doctor" && !staff) throw new Error("Doctors sign up with their @medilink.com email");
  if (role === "patient" && staff) throw new Error("@medilink.com emails are reserved for staff");
  if (role === "patient" && !confirm) throw new Error("Please confirm your details are correct");
  if (role === "doctor" && !licenseNo) throw new Error("Licence number is required");

  const wallet = ethers.Wallet.createRandom();
  await fund(wallet.address);
  const user = { role, name, email: mail, phone, age, specialty, licenseNo, address: wallet.address, key: seal(wallet.privateKey, password) };
  if (role === "patient") user.salt = crypto.randomBytes(16).toString("hex");
  const signer = wallet.connect(provider);
  const r = role === "doctor"
    ? await send(signer, "applyAsDoctor", name, specialty || "General practice", licenseNo)
    : await send(signer, "registerPatient", detailsHash(user));
  db.users.push(user);
  save();
  startSession(res, user, wallet);
  res.json({ role, tx: r.tx, block: r.block });
}));

app.post("/api/signin", wrap(async (req, res) => {
  const user = byEmail(String(req.body.email || "").trim());
  let wallet;
  try { wallet = new ethers.Wallet(unseal(user.key, req.body.password)); } catch { throw new Error("Wrong email or password"); }
  startSession(res, user, wallet);
  res.json({ role: user.role });
}));

app.post("/api/signout", (req, res) => {
  const sid = (req.headers.cookie || "").match(/sid=([a-f0-9]+)/)?.[1];
  sessions.delete(sid);
  res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const s = session(req);
  if (!s) return res.json({ user: null });
  const { name, email, role, address, phone, age, specialty } = s.user;
  res.json({ user: { name, email, role, address, phone, age, specialty } });
});

app.get("/api/public", wrap(async (req, res) => {
  const { slots } = await readAll();
  const now = Date.now() / 1000;
  res.json({ network: NETWORK, contract: deployment.address, slots: slots.filter((s) => s.status === "Open" && s.start > now && s.doctor?.status === "Approved") });
}));

app.get("/api/patient", auth("patient"), wrap(async (req, res) => {
  const all = await readAll();
  const me = req.s.user.address.toLowerCase();
  const verified = await contract.verifyPatient(req.s.user.address, detailsHash(req.s.user));
  const now = Date.now() / 1000;
  const appts = all.appts.filter((a) => a.patient.toLowerCase() === me).reverse().map((a) => ({
    ...a, link: a.mode === "Virtual" && db.meetings[a.id] ? `/meet?id=${a.id}&t=${db.meetings[a.id]}` : null,
    alternatives: a.status === "Reschedule proposed" ? all.slots.filter((s) => s.doctor.address === a.doctor.address && s.status === "Open" && s.start > now) : [],
  }));
  res.json({ verified, appts });
}));

app.post("/api/patient/book", auth("patient"), wrap(async (req, res) => {
  const { slotId, mode } = req.body;
  const virtual = mode === "Virtual";
  const token = virtual ? crypto.randomBytes(16).toString("hex") : null;
  const r = await send(req.s.wallet, "bookSlot", slotId, virtual ? 0 : 1, virtual ? hash(token) : ethers.ZeroHash);
  const ev = r.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "AppointmentBooked");
  const id = Number(ev.args.id);
  if (token) { db.meetings[id] = token; save(); }
  res.json({ id, tx: r.tx, block: r.block, link: token ? `/meet?id=${id}&t=${token}` : null });
}));

for (const [action, fn] of [["cancel", "cancelAppointment"], ["accept", "acceptProposal"], ["decline", "declineProposal"]]) {
  app.post(`/api/patient/${action}`, auth("patient"), wrap(async (req, res) => res.json(await send(req.s.wallet, fn, req.body.id))));
}
app.post("/api/patient/choose", auth("patient"), wrap(async (req, res) => res.json(await send(req.s.wallet, "chooseOtherSlot", req.body.id, req.body.slotId))));

app.get("/api/doctor", auth("doctor"), wrap(async (req, res) => {
  const all = await readAll();
  const me = req.s.user.address.toLowerCase();
  res.json({
    profile: all.doctors[me],
    slots: all.slots.filter((s) => s.doctor.address.toLowerCase() === me).sort((a, b) => a.start - b.start),
    appts: all.appts.filter((a) => a.doctor.address.toLowerCase() === me).reverse()
      .map((a) => ({ ...a, link: a.mode === "Virtual" && db.meetings[a.id] ? `/meet?id=${a.id}&t=${db.meetings[a.id]}` : null })),
  });
}));
app.post("/api/doctor/slot", auth("doctor"), wrap(async (req, res) => {
  const start = Math.floor(new Date(req.body.start).getTime() / 1000);
  if (!start) throw new Error("Choose a date and time");
  const { slots } = await readAll();
  if (slots.some((s) => s.doctor.address === req.s.user.address && s.start === start && s.status !== "Closed")) throw new Error("You already published this time");
  res.json(await send(req.s.wallet, "createSlot", start));
}));
app.post("/api/doctor/close", auth("doctor"), wrap(async (req, res) => res.json(await send(req.s.wallet, "closeSlot", req.body.slotId))));
app.post("/api/doctor/propose", auth("doctor"), wrap(async (req, res) => res.json(await send(req.s.wallet, "proposeReschedule", req.body.id, req.body.slotId, req.body.reason || ""))));
app.post("/api/doctor/complete", auth("doctor"), wrap(async (req, res) => res.json(await send(req.s.wallet, "completeAppointment", req.body.id))));

app.get("/api/admin", auth("admin"), wrap(async (req, res) => {
  const all = await readAll();
  const names = ["DoctorApplied", "DoctorApproved", "DoctorRemoved", "PatientRegistered", "SlotCreated", "SlotClosed", "AppointmentBooked", "RescheduleProposed", "AppointmentRescheduled", "AppointmentCancelled", "AppointmentCompleted"];
  const events = (await Promise.all(names.map(async (n) => contract.queryFilter(n, await fromBlock())))).flat()
    .sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index).slice(0, 60)
    .map((e) => ({ name: e.eventName, block: e.blockNumber, tx: e.transactionHash, args: e.args.toArray().map(String) }));
  const patients = db.users.filter((u) => u.role === "patient").map(({ name, email, address }) => ({ name, email, address }));
  res.json({ ...all, doctors: Object.values(all.doctors), patients, events, contract: deployment.address, network: NETWORK });
}));
app.post("/api/admin/approve", auth("admin"), wrap(async (req, res) => res.json(await send(req.s.wallet, "approveDoctor", req.body.address))));
app.post("/api/admin/remove", auth("admin"), wrap(async (req, res) => res.json(await send(req.s.wallet, "removeDoctor", req.body.address))));

app.get("/api/meet", auth(), wrap(async (req, res) => {
  const id = Number(req.query.id);
  const a = await contract.getAppointment(id);
  const me = req.s.user.address.toLowerCase();
  if (me !== a.patient.toLowerCase() && me !== a.doctor.toLowerCase()) throw new Error("This link belongs to another patient's appointment");
  if (!(await contract.verifyMeeting(id, hash(String(req.query.t || ""))))) throw new Error("Invalid meeting link");
  const s = await contract.getSlot(a.slotId);
  const doc = await contract.doctors(a.doctor);
  res.json({ id, room: `MediLink-${id}-${String(req.query.t).slice(0, 12)}`, start: Number(s.startTime), doctor: doc.name, patient: byAddress(a.patient)?.name, status: STATUS.appt[Number(a.status)] });
}));

provider.on("block", () => broadcast("block"));
app.listen(PORT, () => {
  console.log(`MediLink running at http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK} | Contract: ${deployment.address}`);
});
