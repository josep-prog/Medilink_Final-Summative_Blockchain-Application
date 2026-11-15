// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MediLink appointment registry
/// @notice Enforces booking rules that no single party (admin, doctor or patient) can bypass.
/// @dev Personal data stays off-chain; only hashes of patient details and meeting links are stored.
contract MediLink {
    enum DoctorStatus { None, Pending, Approved, Removed }
    enum SlotStatus { Open, Booked, Held, Closed }
    enum ApptStatus { Booked, RescheduleProposed, Completed, Cancelled }
    enum Mode { Virtual, InPerson }

    struct Doctor {
        string name;
        string specialty;
        string licenseNo;
        DoctorStatus status;
    }

    struct Slot {
        uint256 id;
        address doctor;
        uint64 startTime;
        SlotStatus status;
        uint256 appointmentId;
    }

    struct Appointment {
        uint256 id;
        uint256 slotId;
        address patient;
        address doctor;
        Mode mode;
        bytes32 meetingHash;
        ApptStatus status;
        uint256 proposedSlotId;
        string reason;
    }

    address public immutable admin;
    mapping(address => Doctor) public doctors;
    mapping(address => bytes32) public patientDetails;
    mapping(uint256 => Slot) private slots;
    mapping(uint256 => Appointment) private appointments;
    uint256 public slotCount;
    uint256 public appointmentCount;

    event DoctorApplied(address indexed doctor, string name, string specialty);
    event DoctorApproved(address indexed doctor);
    event DoctorRemoved(address indexed doctor);
    event PatientRegistered(address indexed patient, bytes32 detailsHash);
    event SlotCreated(uint256 indexed slotId, address indexed doctor, uint64 startTime);
    event SlotClosed(uint256 indexed slotId);
    event AppointmentBooked(uint256 indexed id, uint256 indexed slotId, address indexed patient, Mode mode);
    event RescheduleProposed(uint256 indexed id, uint256 proposedSlotId, string reason);
    event AppointmentRescheduled(uint256 indexed id, uint256 newSlotId);
    event AppointmentCancelled(uint256 indexed id, address by);
    event AppointmentCompleted(uint256 indexed id);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier onlyApprovedDoctor() {
        require(doctors[msg.sender].status == DoctorStatus.Approved, "Not an approved doctor");
        _;
    }

    modifier onlyPatientOf(uint256 id) {
        require(id > 0 && id <= appointmentCount, "No such appointment");
        require(appointments[id].patient == msg.sender, "Not your appointment");
        _;
    }

    modifier onlyDoctorOf(uint256 id) {
        require(id > 0 && id <= appointmentCount, "No such appointment");
        require(appointments[id].doctor == msg.sender, "Not your patient");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // ---------- Doctors ----------

    /// @notice A doctor applies for verification. The admin must approve before they can list slots.
    function applyAsDoctor(string calldata name, string calldata specialty, string calldata licenseNo) external {
        require(msg.sender != admin, "Admin cannot be a doctor");
        require(patientDetails[msg.sender] == bytes32(0), "Patients cannot be doctors");
        require(doctors[msg.sender].status == DoctorStatus.None, "Already applied");
        require(bytes(name).length > 0 && bytes(licenseNo).length > 0, "Name and licence required");
        doctors[msg.sender] = Doctor(name, specialty, licenseNo, DoctorStatus.Pending);
        emit DoctorApplied(msg.sender, name, specialty);
    }

    /// @notice Admin verifies a pending doctor.
    function approveDoctor(address doctor) external onlyAdmin {
        require(doctors[doctor].status == DoctorStatus.Pending, "Not pending");
        doctors[doctor].status = DoctorStatus.Approved;
        emit DoctorApproved(doctor);
    }

    /// @notice Admin removes a doctor. Existing appointments are kept; no new slots or bookings.
    function removeDoctor(address doctor) external onlyAdmin {
        DoctorStatus s = doctors[doctor].status;
        require(s == DoctorStatus.Pending || s == DoctorStatus.Approved, "Not active");
        doctors[doctor].status = DoctorStatus.Removed;
        emit DoctorRemoved(doctor);
    }

    // ---------- Patients ----------

    /// @notice Patient confirms their details once; the hash is the proof used for every booking.
    function registerPatient(bytes32 detailsHash) external {
        require(detailsHash != bytes32(0), "Details required");
        require(patientDetails[msg.sender] == bytes32(0), "Already registered");
        require(doctors[msg.sender].status == DoctorStatus.None && msg.sender != admin, "Staff cannot register as patient");
        patientDetails[msg.sender] = detailsHash;
        emit PatientRegistered(msg.sender, detailsHash);
    }

    // ---------- Slots ----------

    /// @notice An approved doctor publishes an available time.
    function createSlot(uint64 startTime) external onlyApprovedDoctor returns (uint256 id) {
        require(startTime > block.timestamp, "Slot must be in the future");
        id = ++slotCount;
        slots[id] = Slot(id, msg.sender, startTime, SlotStatus.Open, 0);
        emit SlotCreated(id, msg.sender, startTime);
    }

    /// @notice A doctor withdraws a slot nobody has booked. Booked slots cannot be withdrawn.
    function closeSlot(uint256 slotId) external {
        Slot storage s = slots[slotId];
        require(s.doctor == msg.sender, "Not your slot");
        require(s.status == SlotStatus.Open, "Slot is not open");
        s.status = SlotStatus.Closed;
        emit SlotClosed(slotId);
    }

    // ---------- Booking ----------

    /// @notice A registered patient books an open slot. A slot can only ever be booked once.
    function bookSlot(uint256 slotId, Mode mode, bytes32 meetingHash) external returns (uint256 id) {
        require(patientDetails[msg.sender] != bytes32(0), "Register as a patient first");
        Slot storage s = slots[slotId];
        require(s.status == SlotStatus.Open, "Slot not available");
        require(s.startTime > block.timestamp, "Slot has passed");
        require(doctors[s.doctor].status == DoctorStatus.Approved, "Doctor not available");
        require(mode == Mode.InPerson || meetingHash != bytes32(0), "Virtual visit needs a meeting link");

        id = ++appointmentCount;
        s.status = SlotStatus.Booked;
        s.appointmentId = id;
        appointments[id] = Appointment(id, slotId, msg.sender, s.doctor, mode, meetingHash, ApptStatus.Booked, 0, "");
        emit AppointmentBooked(id, slotId, msg.sender, mode);
    }

    /// @notice Patient cancels a booked appointment; the slot becomes available again.
    function cancelAppointment(uint256 id) external onlyPatientOf(id) {
        Appointment storage a = appointments[id];
        require(a.status == ApptStatus.Booked, "Cannot cancel now");
        a.status = ApptStatus.Cancelled;
        _reopen(a.slotId);
        emit AppointmentCancelled(id, msg.sender);
    }

    // ---------- Doctor absence ----------

    /// @notice A doctor who cannot attend must give a reason and offer another of their open slots.
    /// @dev The proposed slot is held for this patient; the doctor cannot cancel on their own.
    ///      A doctor removed by the admin can no longer propose; their patients can still cancel.
    function proposeReschedule(uint256 id, uint256 newSlotId, string calldata reason) external onlyDoctorOf(id) onlyApprovedDoctor {
        Appointment storage a = appointments[id];
        require(a.status == ApptStatus.Booked, "Appointment is not booked");
        require(bytes(reason).length > 0, "Reason required");
        Slot storage n = slots[newSlotId];
        require(n.doctor == msg.sender && n.status == SlotStatus.Open && n.startTime > block.timestamp, "Offer one of your open slots");

        n.status = SlotStatus.Held;
        n.appointmentId = id;
        a.status = ApptStatus.RescheduleProposed;
        a.proposedSlotId = newSlotId;
        a.reason = reason;
        emit RescheduleProposed(id, newSlotId, reason);
    }

    /// @notice Patient accepts the doctor's proposed slot, as long as its time has not passed.
    function acceptProposal(uint256 id) external onlyPatientOf(id) {
        Appointment storage a = appointments[id];
        require(a.status == ApptStatus.RescheduleProposed, "No proposal");
        require(slots[a.proposedSlotId].startTime > block.timestamp, "Proposed time has passed");
        _moveTo(a, a.proposedSlotId);
    }

    /// @notice Patient picks any other open slot of the same doctor instead.
    function chooseOtherSlot(uint256 id, uint256 slotId) external onlyPatientOf(id) {
        Appointment storage a = appointments[id];
        require(a.status == ApptStatus.RescheduleProposed, "No proposal");
        Slot storage s = slots[slotId];
        require(s.doctor == a.doctor && s.status == SlotStatus.Open && s.startTime > block.timestamp, "Slot not available");
        _reopen(a.proposedSlotId);
        _moveTo(a, slotId);
    }

    /// @notice Patient declines the proposal and cancels.
    function declineProposal(uint256 id) external onlyPatientOf(id) {
        Appointment storage a = appointments[id];
        require(a.status == ApptStatus.RescheduleProposed, "No proposal");
        _reopen(a.proposedSlotId);
        slots[a.slotId].status = SlotStatus.Closed;
        a.status = ApptStatus.Cancelled;
        emit AppointmentCancelled(id, msg.sender);
    }

    /// @notice Doctor marks the visit done, only once its time has started.
    function completeAppointment(uint256 id) external onlyDoctorOf(id) {
        Appointment storage a = appointments[id];
        require(a.status == ApptStatus.Booked, "Appointment is not booked");
        require(block.timestamp >= slots[a.slotId].startTime, "Appointment has not started");
        a.status = ApptStatus.Completed;
        emit AppointmentCompleted(id);
    }

    // ---------- Reads ----------

    function getSlot(uint256 id) external view returns (Slot memory) {
        return slots[id];
    }

    function getAppointment(uint256 id) external view returns (Appointment memory) {
        return appointments[id];
    }

    /// @notice True if the given meeting link hash belongs to this appointment.
    function verifyMeeting(uint256 id, bytes32 meetingHash) external view returns (bool) {
        return appointments[id].meetingHash == meetingHash && meetingHash != bytes32(0);
    }

    /// @notice True if the given details match what the patient confirmed at registration.
    function verifyPatient(address patient, bytes32 detailsHash) external view returns (bool) {
        return patientDetails[patient] == detailsHash && detailsHash != bytes32(0);
    }

    // ---------- Internal ----------

    function _moveTo(Appointment storage a, uint256 newSlotId) private {
        slots[a.slotId].status = SlotStatus.Closed;
        Slot storage n = slots[newSlotId];
        n.status = SlotStatus.Booked;
        n.appointmentId = a.id;
        a.slotId = newSlotId;
        a.status = ApptStatus.Booked;
        a.proposedSlotId = 0;
        emit AppointmentRescheduled(a.id, newSlotId);
    }

    function _reopen(uint256 slotId) private {
        Slot storage s = slots[slotId];
        s.status = s.startTime > block.timestamp ? SlotStatus.Open : SlotStatus.Closed;
        s.appointmentId = 0;
    }
}
