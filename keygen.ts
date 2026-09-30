/**
 * Generate a fresh EVM key for testnet use and print it once.
 *
 *   pnpm keygen
 *
 * Use it for the reader (AGENT_PRIVATE_KEY) or for the publisher's receiving address (PAY_TO).
 * Treat it as a test key: fund it only with test USDC, and never reuse it on a mainnet.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

console.log(`address            ${account.address}`);
console.log(`AGENT_PRIVATE_KEY=${key}`);
console.log("");
console.log("Fund the address with test USDC at https://faucet.circle.com (network: Base Sepolia).");
console.log("Put the key line in .env here to pay as the reader, or use only the address as PAY_TO for the publisher.");
console.log("This key was printed once and is not saved anywhere. Copy it now.");
