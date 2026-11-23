const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const VIRTUAL = 0, IN_PERSON = 1;
const SLOT = { Open: 0, Booked: 1, Held: 2, Closed: 3 };
const APPT = { Booked: 0, RescheduleProposed: 1, Completed: 2, Cancelled: 3 };
const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("MediLink", function () {
  let ml, admin, doctor, patient, patient2, stranger, t0;

  async function slotAt(hoursFromNow) {
    await ml.connect(doctor).createSlot(t0 + hoursFromNow * 3600);
    return ml.slotCount();
  }

  beforeEach(async function () {
    [admin, doctor, patient, patient2, stranger] = await ethers.getSigners();
    ml = await ethers.deployContract("MediLink");
    t0 = await time.latest();
    await ml.connect(doctor).applyAsDoctor("Dr. Alice Mukamana", "Cardiology", "RMDC-1042");
    await ml.approveDoctor(doctor.address);
    await ml.connect(patient).registerPatient(hash("Jean Mugisha|34|+250788000000"));
    await ml.connect(patient2).registerPatient(hash("Aline Uwase|29|+250788111111"));
  });

  describe("Doctors and patients", function () {
    it("TC01: a doctor's application starts as pending", async function () {
      await ml.connect(stranger).applyAsDoctor("Dr. Eric Nkusi", "Pediatrics", "RMDC-2001");
      expect((await ml.doctors(stranger.address)).status).to.equal(1);
    });

    it("TC02: only the admin can approve a doctor", async function () {
      await ml.connect(stranger).applyAsDoctor("Dr. Eric Nkusi", "Pediatrics", "RMDC-2001");
      await expect(ml.connect(stranger).approveDoctor(stranger.address)).to.be.revertedWith("Only admin");
      await expect(ml.approveDoctor(stranger.address)).to.emit(ml, "DoctorApproved");
    });

    it("TC03: an unapproved doctor cannot create slots", async function () {
      await ml.connect(stranger).applyAsDoctor("Dr. Eric Nkusi", "Pediatrics", "RMDC-2001");
      await expect(ml.connect(stranger).createSlot(t0 + 3600)).to.be.revertedWith("Not an approved doctor");
    });

    it("TC04: a patient's details are confirmed on-chain and can be verified", async function () {
      expect(await ml.verifyPatient(patient.address, hash("Jean Mugisha|34|+250788000000"))).to.equal(true);
      expect(await ml.verifyPatient(patient.address, hash("Jean Mugisha|43|+250788000000"))).to.equal(false);
    });

    it("TC05: a doctor cannot register as a patient", async function () {
      await expect(ml.connect(doctor).registerPatient(hash("x"))).to.be.revertedWith("Staff cannot register as patient");
    });
  });

  describe("Slots and booking", function () {
    it("TC06: an approved doctor publishes a future slot", async function () {
      const id = await slotAt(24);
      const s = await ml.getSlot(id);
      expect(s.doctor).to.equal(doctor.address);
      expect(s.status).to.equal(SLOT.Open);
    });

    it("TC07: slots in the past are rejected", async function () {
      await expect(ml.connect(doctor).createSlot(t0 - 60)).to.be.revertedWith("Slot must be in the future");
    });

    it("TC08: a patient books a slot as an in-person visit", async function () {
      const id = await slotAt(24);
      await expect(ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash)).to.emit(ml, "AppointmentBooked");
      expect((await ml.getSlot(id)).status).to.equal(SLOT.Booked);
    });

    it("TC09: the same slot can never be booked twice", async function () {
      const id = await slotAt(24);
      await ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash);
      await expect(ml.connect(patient2).bookSlot(id, IN_PERSON, ethers.ZeroHash)).to.be.revertedWith("Slot not available");
    });

    it("TC10: unregistered users and doctors cannot book", async function () {
      const id = await slotAt(24);
      await expect(ml.connect(stranger).bookSlot(id, IN_PERSON, ethers.ZeroHash)).to.be.revertedWith("Register as a patient first");
      await expect(ml.connect(doctor).bookSlot(id, IN_PERSON, ethers.ZeroHash)).to.be.revertedWith("Register as a patient first");
    });

    it("TC11: a virtual visit stores a private meeting-link hash", async function () {
      const id = await slotAt(24);
      await expect(ml.connect(patient).bookSlot(id, VIRTUAL, ethers.ZeroHash)).to.be.revertedWith("Virtual visit needs a meeting link");
      await ml.connect(patient).bookSlot(id, VIRTUAL, hash("secret-room-token"));
      expect(await ml.verifyMeeting(1, hash("secret-room-token"))).to.equal(true);
      expect(await ml.verifyMeeting(1, hash("guessed-token"))).to.equal(false);
    });

    it("TC12: a doctor cannot withdraw a slot that is already booked", async function () {
      const id = await slotAt(24);
      await ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash);
      await expect(ml.connect(doctor).closeSlot(id)).to.be.revertedWith("Slot is not open");
    });

    it("TC13: a patient cancels and the slot opens for others", async function () {
      const id = await slotAt(24);
      await ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash);
      await ml.connect(patient).cancelAppointment(1);
      expect((await ml.getSlot(id)).status).to.equal(SLOT.Open);
      await expect(ml.connect(patient2).bookSlot(id, IN_PERSON, ethers.ZeroHash)).to.emit(ml, "AppointmentBooked");
    });
  });

  describe("Doctor absence and rescheduling", function () {
    let booked, offer, other;
    beforeEach(async function () {
      booked = await slotAt(24);
      offer = await slotAt(48);
      other = await slotAt(72);
      await ml.connect(patient).bookSlot(booked, VIRTUAL, hash("room"));
    });

    it("TC14: a doctor must give a reason to reschedule", async function () {
      await expect(ml.connect(doctor).proposeReschedule(1, offer, "")).to.be.revertedWith("Reason required");
    });

    it("TC15: the proposed slot is held for this patient only", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      expect((await ml.getSlot(offer)).status).to.equal(SLOT.Held);
      await expect(ml.connect(patient2).bookSlot(offer, IN_PERSON, ethers.ZeroHash)).to.be.revertedWith("Slot not available");
    });

    it("TC16: the patient accepts the proposal", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await ml.connect(patient).acceptProposal(1);
      const a = await ml.getAppointment(1);
      expect(a.slotId).to.equal(offer);
      expect(a.status).to.equal(APPT.Booked);
      expect((await ml.getSlot(booked)).status).to.equal(SLOT.Closed);
    });

    it("TC17: the patient picks another open slot instead", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await ml.connect(patient).chooseOtherSlot(1, other);
      expect((await ml.getAppointment(1)).slotId).to.equal(other);
      expect((await ml.getSlot(offer)).status).to.equal(SLOT.Open);
    });

    it("TC18: the patient declines and the appointment is cancelled", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await ml.connect(patient).declineProposal(1);
      expect((await ml.getAppointment(1)).status).to.equal(APPT.Cancelled);
      expect((await ml.getSlot(offer)).status).to.equal(SLOT.Open);
    });

    it("TC19: only the patient can answer a proposal", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await expect(ml.connect(doctor).acceptProposal(1)).to.be.revertedWith("Not your appointment");
      await expect(ml.connect(admin).declineProposal(1)).to.be.revertedWith("Not your appointment");
    });

    it("TC23: a proposal whose time has passed cannot be accepted", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await time.increase(49 * 3600);
      await expect(ml.connect(patient).acceptProposal(1)).to.be.revertedWith("Proposed time has passed");
    });

    it("TC24: a removed doctor cannot propose a reschedule", async function () {
      await ml.removeDoctor(doctor.address);
      await expect(ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery")).to.be.revertedWith("Not an approved doctor");
    });

    it("TC26: a doctor can reschedule one appointment at most twice", async function () {
      const fourth = await slotAt(96);
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await ml.connect(patient).acceptProposal(1);
      await ml.connect(doctor).proposeReschedule(1, other, "Conference");
      await ml.connect(patient).acceptProposal(1);
      expect(await ml.rescheduleCount(1)).to.equal(2);
      await expect(ml.connect(doctor).proposeReschedule(1, fourth, "Again")).to.be.revertedWith("Reschedule limit reached");
    });

    it("TC27: a patient cannot move to a time from a doctor who has been removed", async function () {
      await ml.connect(doctor).proposeReschedule(1, offer, "Emergency surgery");
      await ml.removeDoctor(doctor.address);
      await expect(ml.connect(patient).acceptProposal(1)).to.be.revertedWith("Doctor not available");
      await expect(ml.connect(patient).chooseOtherSlot(1, other)).to.be.revertedWith("Doctor not available");
      await ml.connect(patient).declineProposal(1);
      expect((await ml.getAppointment(1)).status).to.equal(APPT.Cancelled);
    });
  });

  describe("Admin limits and completion", function () {
    it("TC20: the admin cannot cancel a patient's appointment", async function () {
      const id = await slotAt(24);
      await ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash);
      await expect(ml.connect(admin).cancelAppointment(1)).to.be.revertedWith("Not your appointment");
    });

    it("TC21: a removed doctor keeps existing bookings but loses new ones", async function () {
      const a = await slotAt(24);
      const b = await slotAt(48);
      await ml.connect(patient).bookSlot(a, IN_PERSON, ethers.ZeroHash);
      await ml.removeDoctor(doctor.address);
      expect((await ml.getAppointment(1)).status).to.equal(APPT.Booked);
      await expect(ml.connect(patient2).bookSlot(b, IN_PERSON, ethers.ZeroHash)).to.be.revertedWith("Doctor not available");
    });

    it("TC22: a visit can only be completed once its time has started", async function () {
      const id = await slotAt(1);
      await ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash);
      await expect(ml.connect(doctor).completeAppointment(1)).to.be.revertedWith("Appointment has not started");
      await time.increase(3600);
      await expect(ml.connect(doctor).completeAppointment(1)).to.emit(ml, "AppointmentCompleted");
    });

    it("TC25: a patient cannot cancel once the visit time has started", async function () {
      const id = await slotAt(1);
      await ml.connect(patient).bookSlot(id, IN_PERSON, ethers.ZeroHash);
      await time.increase(3600);
      await expect(ml.connect(patient).cancelAppointment(1)).to.be.revertedWith("Visit time has passed");
      await expect(ml.connect(doctor).completeAppointment(1)).to.emit(ml, "AppointmentCompleted");
    });
  });
});
