# MediLink

Hospital appointment booking for Rwanda, with the booking rules enforced by an Ethereum smart contract.

- Patients sign up once and confirm their details. Only a hash of those details goes on-chain.
- Doctors sign up with their `@medilink.com` email and can only publish times after the admin approves them.
- Each time slot can be booked by exactly one patient. Doctors cannot book.
- Virtual visits get a private meeting link. Its hash is stored on-chain, and it only opens for that patient and doctor.
- A doctor who cannot attend must give a reason and offer another time. The patient accepts it, picks another open time, or declines.
- The admin sees all activity and manages doctors, but cannot cancel or change any appointment.

## Project layout

| Path | Purpose |
| --- | --- |
| `contracts/MediLink.sol` | Smart contract |
| `test/MediLink.test.js` | 27 test cases (TC01–TC27) |
| `scripts/deploy.js` | Deploys and saves address + ABI to `deployments/<network>.json` |
| `scripts/interact.js` | Runs the full booking flow on a deployed contract |
| `server/index.js` | Web server: accounts, per-user wallets, blockchain calls, live updates |
| `public/` | Home page, sign up/in, patient, doctor and admin portals, meeting room |

## Run locally

Requires Node.js 18+.

```bash
npm install
npx hardhat test          # 27 passing
npm run chain             # terminal 1: local Ethereum node
npm run deploy:local      # terminal 2: deploy the contract
npm start                 # terminal 2: app at http://localhost:3000
```

Admin sign-in: `admin@medilink.com`, password from `ADMIN_PASSWORD` in `.env` (default `Admin@2026`).

## Deploy to Sepolia

1. `cp .env.example .env` and set `SEPOLIA_RPC_URL` and `PRIVATE_KEY` (a test wallet with Sepolia ETH from a faucet).
2. `npm run deploy:sepolia`
3. `npm run interact:sepolia`
4. Optional: `npx hardhat verify --network sepolia <address>` with `ETHERSCAN_API_KEY` set.
5. To run the app against Sepolia: `NETWORK=sepolia npm start`.

Current Sepolia deployment: [0x6E3d5A3db32e1aF794A920E368Ff219136Eade7B](https://sepolia.etherscan.io/address/0x6E3d5A3db32e1aF794A920E368Ff219136Eade7B)
