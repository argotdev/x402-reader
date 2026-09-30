/**
 * Show the USDC balance of an address on Base Sepolia (or mainnet with NETWORK=eip155:8453).
 *
 *   pnpm balance                 the address of AGENT_PRIVATE_KEY from .env
 *   pnpm balance 0xYourAddress   any address
 */
import { createPublicClient, formatUnits, http, isAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const USDC: Record<string, Address> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const network = process.env.NETWORK ?? "eip155:84532";
const chain = network === "eip155:8453" ? base : baseSepolia;
const arg = process.argv[2];
const key = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;

let address: Address;
if (arg && isAddress(arg)) address = arg;
else if (key) address = privateKeyToAccount(key).address;
else {
  console.error("usage: pnpm balance <address>   (or set AGENT_PRIVATE_KEY in .env)");
  process.exit(1);
}

const client = createPublicClient({ chain, transport: http() });
const [usdc, eth] = await Promise.all([
  client.readContract({
    address: USDC[network],
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [address],
  }),
  client.getBalance({ address }),
]);

console.log(`address  ${address}`);
console.log(`network  ${chain.name} (${network})`);
console.log(`USDC     ${formatUnits(usdc, 6)}`);
console.log(`ETH      ${formatUnits(eth, 18)}   (not needed: the facilitator pays gas)`);
if (usdc === 0n) console.log("\nNo USDC yet. Request some at https://faucet.circle.com and choose Base Sepolia.");
