// Runs the MediLink flow on the deployed contract: approve doctor, publish slots, book,
// block a double booking, and reschedule with a reason.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const link = (h) => (network.name === "sepolia" ? `https://sepolia.etherscan.io/tx/${h}` : h);

const why = (e) => e.reason || /reverted:? ([^"\n]+)/.exec(e.message)?.[1] || e.shortMessage;

// Public RPC nodes can lag a block behind, so a call that depends on the previous step is retried.
async function send(label, makeTx) {
  let tx;
  for (let i = 0; ; i++) {
    try { tx = await makeTx(); break; }
    catch (e) { if (i === 4) throw e; await new Promise((r) => setTimeout(r, 4000)); }
  }
  await tx.wait(2);
  console.log(`${label.padEnd(44)} ${link(tx.hash)}`);
  return tx;
}

async function eventArg(ml, tx, name, arg) {
  const rc = await ethers.provider.getTransactionReceipt(tx.hash);
  return rc.logs.map((l) => { try { return ml.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name).args[arg];
}

async function main() {
  const { address } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`)));
  const [admin] = await ethers.getSigners();
  const ml = await ethers.getContractAt("MediLink", address, admin);
  console.log(`MediLink on ${network.name}: ${address}\n`);

  const doctor = ethers.Wallet.createRandom().connect(ethers.provider);
  const patient = ethers.Wallet.createRandom().connect(ethers.provider);
  for (const [who, w] of [["doctor", doctor], ["patient", patient]]) {
    await send(`Fund ${who} wallet for gas`, () => admin.sendTransaction({ to: w.address, value: ethers.parseEther("0.0001") }));
  }

  await send("Doctor applies (Dr. Alice Mukamana)", () => ml.connect(doctor).applyAsDoctor("Dr. Alice Mukamana", "Cardiology", "RMDC-1042"));
  await send("Admin approves the doctor", () => ml.approveDoctor(doctor.address));

  const now = Math.floor(Date.now() / 1000);
  const slotA = await eventArg(ml, await send("Doctor publishes slot: tomorrow", () => ml.connect(doctor).createSlot(now + 86400)), "SlotCreated", "slotId");
  const slotB = await eventArg(ml, await send("Doctor publishes slot: in two days", () => ml.connect(doctor).createSlot(now + 2 * 86400)), "SlotCreated", "slotId");

  await send("Patient confirms details (hash only)", () => ml.connect(patient).registerPatient(hash("Jean Mugisha|34|+250788000000")));
  const book = await send(`Patient books slot #${slotA} as a virtual visit`, () => ml.connect(patient).bookSlot(slotA, 0, hash("private-room-token")));
  const id = await eventArg(ml, book, "AppointmentBooked", "id");

  try {
    await ml.connect(patient).bookSlot.staticCall(slotA, 1, ethers.ZeroHash);
    console.log("Slot was booked twice (unexpected)");
  } catch (e) {
    console.log(`${"Booking the same slot again".padEnd(44)} blocked: ${why(e)}`);
  }

  await send(`Doctor cannot attend: offers slot #${slotB}`, () => ml.connect(doctor).proposeReschedule(id, slotB, "Emergency surgery"));
  await send("Patient accepts the new time", () => ml.connect(patient).acceptProposal(id));

  const a = await ml.getAppointment(id);
  console.log(`\nAppointment #${id}: slot #${a.slotId}, status ${["Booked", "RescheduleProposed", "Completed", "Cancelled"][Number(a.status)]}`);
  console.log(`Meeting link verified: ${await ml.verifyMeeting(id, hash("private-room-token"))}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
