import * as readline from "readline";
import * as os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { randomBytes, createHash } from "crypto";
import * as bech32 from "bech32";
import { fromBase64 } from "@cosmjs/encoding";
import {
  ChainGrpcBankApi,
  ChainGrpcWasmApi,
  MsgBroadcasterWithPk,
  PrivateKey,
  MsgExecuteContractCompat,
  toBase64,
} from "@injectivelabs/sdk-ts";
import { Network, getNetworkEndpoints } from "@injectivelabs/networks";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const ASTATINE_ASCII = `
\x1b[32m
      █████╗ ███████╗████████╗ █████╗ ████████╗██╗███╗   ██╗███████╗
     ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║████╗  ██║██╔════╝
     ███████║███████╗   ██║   ███████║   ██║   ██║██╔██╗ ██║█████╗  
     ██╔══██║╚════██║   ██║   ██╔══██║   ██║   ██║██║╚██╗██║██╔══╝  
     ██║  ██║███████║   ██║   ██║  ██║   ██║   ██║██║ ╚████║███████╗
     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝ miner-cli
\x1b[0m
`;

const ascii = `
\x1b[32m
     ▗▄▖  ▗▄▄▖▗▄▄▄▖▗▄▖▗▄▄▄▖▗▄▄▄▖▗▖  ▗▖▗▄▄▄▖
    ▐▌ ▐▌▐▌     █ ▐▌ ▐▌ █    █  ▐▛▚▖▐▌▐▌   
    ▐▛▀▜▌ ▝▀▚▖  █ ▐▛▀▜▌ █    █  ▐▌ ▝▜▌▐▛▀▀▘
    ▐▌ ▐▌▗▄▄▞▘  █ ▐▌ ▐▌ █  ▗▄█▄▖▐▌  ▐▌▐▙▄▄▖ miner-cli
\x1b[0m
`;

const nodes = [
  "inj1qfd8vwq0j4ps2mn0felam8f4u8a5xvxn39ezfy",
  "inj1wgvjaat3gna8dvuz7vqv6jmveng8kftlxklxjr",
  "inj1h9uwgtd9dfcgfzvr870ge0cxq3erqrvzd2r5fz",
];

const NETWORK = (process.env.NETWORK || "testnet") as "mainnet" | "testnet";
const ENDPOINTS = getNetworkEndpoints(
  NETWORK === "mainnet" ? Network.Mainnet : Network.Testnet
);
const GRPC = ENDPOINTS.grpc;
const SELECTED_NODE = process.env.VALIDATOR_NO;

const CONTRACT = nodes[Number(SELECTED_NODE) - 1];

const SUBMIT_FEE_INJ = Number(process.env.SUBMIT_FEE_INJ || "0.01");
const GAS_LIMIT = Number(process.env.GAS_LIMIT || "400000");
const HDPATH_DEFAULT = `m/44'/60'/0'/0/0`;
const FINALIZE_COOLDOWN_MS = 4000;
const BEST_POLL_MS = Number("5000");

let logoShown = false;

let HUD_LINES = 0;
function renderHUD(lines: any[]) {
  if (!logoShown) {
    console.clear();
    process.stdout.write(ASTATINE_ASCII);
    logoShown = true;
  }

  if (HUD_LINES > 0) {
    process.stdout.write(`\x1b[${HUD_LINES}A`);
  }

  const maxLines = Math.max(HUD_LINES, lines.length);

  for (let i = 0; i < maxLines; i++) {
    process.stdout.write("\x1b[2K");
    if (i < lines.length) {
      process.stdout.write(String(lines[i]));
    }
    process.stdout.write("\n");
  }

  HUD_LINES = lines.length;
}

type WorkResp = {
  height?: string | number;
  seed?: string;
  prev_hash?: string;
  target?: string;
  reward?: string;
  window_expires_at_secs?: string | number;
};
type ContestResp = {
  height?: string | number;
  window_starts_at?: string | number;
  window_expires_at_secs?: string | number;
  has_candidate?: boolean;
  best_miner?: string | null;
  best_hash?: string | null;
  finalized?: boolean;
};

const C = {
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
  b: (s: string) => `\x1b[34m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
function hudLine(s: string) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(s);
}
function bar(pct: number, width = 24) {
  const full = Math.round(pct * width);
  return "▮".repeat(full) + "▯".repeat(width - full);
}
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(m)}:${pad(r)}`;
}
function injToWeiStr(amountInInj: number) {
  const s = amountInInj.toFixed(18);
  const [ip, fp = ""] = s.split(".");
  return (ip + fp).replace(/^0+/, "") || "0";
}
function canonFromBech32(addr: string): Buffer {
  const dec = bech32.bech32.decode(addr);
  const raw = bech32.bech32.fromWords(dec.words);
  return Buffer.from(raw);
}
function hexTo32BE(hex: string) {
  const s = hex.length % 2 ? "0" + hex : hex;
  const buf = Buffer.from(s, "hex");
  if (buf.length === 32) return buf;
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}
function inc128BE(buf: Buffer) {
  if (buf.length < 16)
    throw new Error(`inc128BE expects 16 bytes, got ${buf.length}`);
  for (let i = 15; i >= 0; i--) {
    const b = buf.readUInt8(i);
    if (b === 0xff) {
      buf.writeUInt8(0x00, i);
      continue;
    }
    buf.writeUInt8(b + 1, i);
    break;
  }
}

const bankApi = new ChainGrpcBankApi(GRPC);
const wasmApi = new ChainGrpcWasmApi(GRPC);

async function getInjBalance(address: string): Promise<bigint> {
  const res = await bankApi.fetchBalance({
    accountAddress: address,
    denom: "inj",
  });
  return BigInt(res.amount || "0");
}
async function getAstBalance(address: string): Promise<string> {
  try {
    const res = await bankApi.fetchBalance({
      accountAddress: address,
      denom: "factory/inj1k9hde84nufwmzq0wf6xs4jysll60fy6hd72ws2/AST",
    });

    return res.amount || "0";
  } catch {}
  return "0";
}
async function qWork(contract: string): Promise<WorkResp> {
  const raw = await wasmApi.fetchSmartContractState(
    contract,
    toBase64({ work: {} })
  );
  return JSON.parse(Buffer.from(raw.data).toString());
}
async function qContest(contract: string): Promise<ContestResp> {
  const raw = await wasmApi.fetchSmartContractState(
    contract,
    toBase64({ contest_summary: {} })
  );
  return JSON.parse(Buffer.from(raw.data).toString());
}

function pkFromMnemonic(mnemonic: string, hdpath = HDPATH_DEFAULT) {
  return PrivateKey.fromMnemonic(mnemonic, hdpath);
}
async function submitSolution(
  mnemonic: string,
  sender: string,
  contract: string,
  headerB64: string,
  nonce: bigint
) {
  const pk = pkFromMnemonic(mnemonic, HDPATH_DEFAULT);
  const broadcaster = new MsgBroadcasterWithPk({
    privateKey: pk.toPrivateKeyHex(),
    network: Network.Testnet,
  });
  const funds = [{ denom: "inj", amount: injToWeiStr(SUBMIT_FEE_INJ) }];
  const msg = MsgExecuteContractCompat.fromJSON({
    contractAddress: contract,
    sender,
    msg: { submit_solution: { header: headerB64, nonce: nonce.toString() } },
    funds,
  });
  const resp = await broadcaster.broadcast({
    msgs: msg,
    gas: { gas: GAS_LIMIT },
  });
  return resp;
}
async function finalizeWindow(
  mnemonic: string,
  sender: string,
  contract: string
) {
  const pk = pkFromMnemonic(mnemonic, HDPATH_DEFAULT);
  const broadcaster = new MsgBroadcasterWithPk({
    privateKey: pk.toPrivateKeyHex(),
    network: Network.Testnet,
  });
  const msg = MsgExecuteContractCompat.fromJSON({
    contractAddress: contract,
    sender,
    msg: { finalize_window: {} },
    funds: [],
  });
  const resp = await broadcaster.broadcast({
    msgs: msg,
    gas: { gas: GAS_LIMIT },
  });
  return resp;
}

function buildPreimageStatic(seed: Buffer, miner: Buffer, header: Buffer) {
  const total = seed.length + miner.length + 16 + header.length;
  const pre = Buffer.allocUnsafe(total);
  let off = 0;
  seed.copy(pre, off);
  off += seed.length;
  miner.copy(pre, off);
  off += miner.length;
  const nonceOffset = off;
  off += 16;
  header.copy(pre, off);
  return { pre, nonceOffset };
}

type WorkerIn = {
  seed: Uint8Array | Buffer;
  header: Uint8Array | Buffer;
  minerCanon: Uint8Array | Buffer;
  target: Uint8Array | Buffer;
  best: Uint8Array | Buffer | null;
  batch: number;
  wid: number;
};

type WorkerOut =
  | { type: "rate"; hps: number; wid: number }
  | { type: "found"; nonce: string; hashHex: string; wid: number };

if (!isMainThread) {
  const { seed, header, minerCanon, target, best, batch, wid } =
    workerData as WorkerIn;

  const sU8 = seed instanceof Uint8Array ? seed : new Uint8Array(seed as any);
  const hU8 =
    header instanceof Uint8Array ? header : new Uint8Array(header as any);
  const mU8 =
    minerCanon instanceof Uint8Array
      ? minerCanon
      : new Uint8Array(minerCanon as any);
  const tU8 =
    target instanceof Uint8Array ? target : new Uint8Array(target as any);
  const bU8 = best
    ? best instanceof Uint8Array
      ? best
      : new Uint8Array(best as any)
    : null;

  const seedBuf = Buffer.from(sU8.buffer, sU8.byteOffset, sU8.byteLength);
  const headerBuf = Buffer.from(hU8.buffer, hU8.byteOffset, hU8.byteLength);
  const minerBuf = Buffer.from(mU8.buffer, mU8.byteOffset, mU8.byteLength);
  const targetBuf = Buffer.from(tU8.buffer, tU8.byteOffset, tU8.byteLength);
  let bestBuf: Buffer | null = bU8
    ? Buffer.from(bU8.buffer, bU8.byteOffset, bU8.byteLength)
    : null;

  parentPort!.on("message", (msg: any) => {
    if (msg?.type === "best") {
      const bestHex: string | null = msg.bestHex ?? null;
      if (bestHex) {
        const s = bestHex.length % 2 ? "0" + bestHex : bestHex;
        const raw = Buffer.from(s, "hex");
        const out = Buffer.alloc(32);
        raw.copy(out, 32 - raw.length);
        bestBuf = out;
      } else {
        bestBuf = null;
      }
    }
  });

  const { pre, nonceOffset } = buildPreimageStatic(
    seedBuf,
    minerBuf,
    headerBuf
  );

  const BATCH = Math.max(10_000, Math.min(400_000, batch || 100_000));
  const nonceB = Buffer.allocUnsafe(16);
  randomBytes(16).copy(nonceB);
  let attempts = 0;
  let last = Date.now();

  for (;;) {
    for (let i = 0; i < BATCH; i++) {
      inc128BE(nonceB);
      nonceB.copy(pre, nonceOffset);

      const h1 = createHash("sha256").update(pre).digest();
      const h2 = createHash("sha256").update(h1).digest();

      attempts++;

      if (h2.compare(targetBuf) <= 0 && (!bestBuf || h2.compare(bestBuf) < 0)) {
        parentPort!.postMessage({
          type: "found",
          nonce: BigInt("0x" + nonceB.toString("hex")).toString(),
          hashHex: h2.toString("hex"),
          wid,
        });
        process.exit(0);
      }
    }
    const now = Date.now();
    if (now - last >= 500) {
      parentPort!.postMessage({ type: "rate", hps: attempts * 2, wid });
      attempts = 0;
      last = now;
    }
  }
}

let best_addr: string | undefined;
let finalizeTx: string | undefined;
let submitTx: string | undefined;

async function mineOneContract(
  mnemonic: string,
  address: string,
  contract: string,
  threads: number,
  astBal: string,
  injBal: bigint
) {
  let work = await qWork(contract);
  let contest = await qContest(contract);
  if (contest.window_expires_at_secs == 131313) {
    console.log(C.r("Genesis not ready. Skipping."));
    return;
  }

  const expires = Number(
    work.window_expires_at_secs || contest.window_expires_at_secs || 0
  );
  const seedB64 = work.seed!;
  const headerB64 = work.prev_hash!;
  const targetHex = BigInt(work.target!).toString(16).padStart(64, "0");
  let bestHex: string | null = contest.best_hash
    ? Buffer.from(fromBase64(contest.best_hash)).toString("hex")
    : null;

  const seedBuf = Buffer.from(fromBase64(seedB64));
  const headerBuf = Buffer.from(fromBase64(headerB64));
  const minerBuf = canonFromBech32(address);
  const targetBuf = hexTo32BE(targetHex);
  let bestBuf = bestHex ? hexTo32BE(bestHex) : null;

  const height = work.height ?? contest.height ?? "?";

  const cpu = os.cpus()?.length || 1;
  const nWorkers = threads > 0 ? threads : Math.max(1, cpu);
  const baseBatch = 100_000;

  const workers: Worker[] = [];
  const perWorker = new Array(nWorkers).fill(0);
  let found: { nonce: bigint; hashHex: string } = {
    nonce: BigInt(1),
    hashHex: "none",
  };

  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(new URL(import.meta.url), {
      execArgv: ["--loader", "ts-node/esm", "--no-warnings"],
      workerData: {
        seed: seedBuf,
        header: headerBuf,
        minerCanon: minerBuf,
        target: targetBuf,
        best: bestBuf,
        batch: baseBatch,
        wid: i,
      } as WorkerIn,
    });
    w.on("message", (m: WorkerOut) => {
      if (m.type === "rate") {
        perWorker[m.wid] = m.hps ?? 0;
      } else if (m.type === "found") {
        found = { nonce: BigInt(m.nonce), hashHex: m.hashHex };
        for (const ww of workers) {
          try {
            ww.terminate();
          } catch {}
        }
      }
    });
    w.on("error", (err) => console.error(`Worker ${i} error:`, err));
    w.on("exit", (code) => {});
    workers.push(w);
  }

  let lastHud = Date.now();
  let lastBestPoll = 0;
  let lastBestHexSent: string | null = bestHex ?? null;

  for (;;) {
    await sleep(250);

    const left = Math.max(0, expires - Math.floor(Date.now() / 1000));
    if (left === 0) {
      for (const ww of workers) {
        try {
          ww.terminate();
        } catch {}
      }
      try {
        const resp = await finalizeWindow(mnemonic, address, contract);
        if (resp) {
          finalizeTx = resp.txHash;
          submitTx = undefined;
        }
      } catch (e: any) {
        finalizeTx = e.message;
      }
      await sleep(FINALIZE_COOLDOWN_MS);
      return;
    }

    const nowMs = Date.now();
    if (nowMs - lastBestPoll >= BEST_POLL_MS) {
      lastBestPoll = nowMs;
      try {
        const c2 = await qContest(contract);
        const incomingHex = c2.best_hash
          ? Buffer.from(fromBase64(c2.best_hash)).toString("hex")
          : null;
        best_addr = c2.best_miner ? c2.best_miner : undefined;

        if (incomingHex !== lastBestHexSent) {
          lastBestHexSent = incomingHex;

          if (incomingHex) {
            bestHex = incomingHex;
            bestBuf = hexTo32BE(incomingHex);
          } else {
            bestHex = null;
            bestBuf = null;
          }

          for (const w of workers) {
            try {
              w.postMessage({ type: "best", bestHex: incomingHex ?? null });
            } catch {}
          }
        }
      } catch {}
    }

    if (Date.now() - lastHud >= 1000) {
      const totalHps = perWorker.reduce((a, b) => a + (b ?? 0), 0);
      const astatineTitle =
        `${C.g("Astatine Miner")}  ` +
        `| Address ${C.y(
          address.slice(0, 5) +
            ".." +
            address.slice(address.length - 5, address.length - 1)
        )}  `;

      const balances =
        `AST Balance ${C.b(String((Number(astBal) / 10 ** 18).toFixed(2)))}  ` +
        `INJ Balance ${C.y(String((Number(injBal) / 10 ** 18).toFixed(2)))}  `;
      const headerLine =
        `${C.c(`H/s ${totalHps.toLocaleString()}`)}  ` +
        `| Left ${C.r(formatClock(left))}  ` +
        `| Block ${C.g(String(height))}  ` +
        `| Target ${C.dim("0x" + targetHex.slice(0, 8) + "…")}`;

      const infoLine =
        `${"Reward"} ${C.g(
          work.reward
            ? (Number(work.reward) / 10 ** 18).toFixed() + " AST"
            : "?"
        )} | ` +
        `${"Best"} ${C.dim(bestHex ? "0x" + bestHex.slice(0, 8) + "…" : "—")}`;
      const finalizePart = `${"Finalize TX : "} ${
        finalizeTx ? C.dim(finalizeTx) : C.dim("not available")
      } `;
      const submitPart = `${"Mining TX : "} ${
        submitTx ? C.dim(submitTx) : C.dim("not available")
      }  `;
      const currentWinner = `${"Best Miner : "} ${
        best_addr
          ? best_addr == address
            ? C.dim(
                best_addr.slice(0, 5) +
                  "..." +
                  best_addr.slice(best_addr.length - 5, best_addr.length - 1)
              ) + C.g(" (you)")
            : C.dim(
                best_addr.slice(0, 5) +
                  "..." +
                  best_addr.slice(best_addr.length - 5, best_addr.length - 1)
              )
          : C.dim("not available")
      }  `;
      const avg = totalHps / Math.max(1, perWorker.length);

      let workers = [];

      for (let i = 0; i < perWorker.length; i++) {
        const v = perWorker[i] ?? 0;
        const rel = Math.min(1, avg ? v / avg : 0);

        workers.push(
          ` w${i.toString().padStart(2, "0")}: ${bar(rel)} ${C.dim(
            v.toLocaleString() + " H/s"
          )}`
        );
      }

      renderHUD([
        astatineTitle,
        balances,
        headerLine,
        infoLine,
        finalizePart,
        submitPart,
        currentWinner,
        ...workers,
      ]);

      lastHud = Date.now();
    }

    if (found.hashHex !== "none") {
      const freshWork = await qWork(contract);
      const freshContest = await qContest(contract);
      if (!freshWork.seed || !freshWork.prev_hash || !freshWork.target) {
        found.hashHex = "none";
        continue;
      }

      const s2 = Buffer.from(fromBase64(freshWork.seed));
      const h2 = Buffer.from(fromBase64(freshWork.prev_hash));
      const m2 = minerBuf;
      const { pre: pre2, nonceOffset: no2 } = buildPreimageStatic(s2, m2, h2);

      const nonceHex = found.nonce.toString(16).padStart(32, "0");
      Buffer.from(nonceHex, "hex").copy(pre2, no2);

      const f1 = createHash("sha256").update(pre2).digest();
      const f2 = createHash("sha256").update(f1).digest();

      const tgt2 = hexTo32BE(
        BigInt(freshWork.target).toString(16).padStart(64, "0")
      );
      const bst2 = freshContest.best_hash
        ? hexTo32BE(
            Buffer.from(fromBase64(freshContest.best_hash)).toString("hex")
          )
        : null;

      const okTarget = f2.compare(tgt2) <= 0;
      const okBest = !bst2 || f2.compare(bst2) < 0;

      if (!(okTarget && okBest)) {
        found.hashHex = "none";
        continue;
      }

      try {
        const resp = await submitSolution(
          mnemonic,
          address,
          contract,
          freshWork.prev_hash,
          found.nonce
        );
        if (resp) {
          submitTx = resp.txHash;
        }
      } catch (e: any) {
        submitTx = e.message;
      }
      found.hashHex = "none";
    }
  }
}

async function prompt(question: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((res) =>
    rl.question(question, (ans) => {
      rl.close();
      res(ans);
    })
  );
}

async function main() {
  if (!isMainThread) return;

  const args = process.argv.slice(2);
  const idxMnemonic = args.indexOf("--mnemonic");

  const mnemonic =
    idxMnemonic >= 0
      ? args[idxMnemonic + 1]
      : await prompt("12-word mnemonic: ");
  const hd = HDPATH_DEFAULT;
  const threads = 0;

  if (!mnemonic) return;

  const pk = pkFromMnemonic(mnemonic, hd);
  const address = pk.toBech32();

  const injBalance = await getInjBalance(address);

  if (injBalance < BigInt(1e18)) {
    console.error(C.r("Min 1 INJ required. Exiting..."));
    process.exit(1);
  }

  while (true) {
    logoShown = false;
    const injBal = await getInjBalance(address);
    if (injBal <= BigInt(1e16)) {
      console.clear();
      console.log(
        C.r(
          "Your INJ balance is less than 0.01 INJ, please add at least 1 INJ and reboot the cli."
        )
      );
      process.exit(1);
    }
    const astBal = await getAstBalance(address);
    if (!CONTRACT) {
      console.log("Contract not found");
      return;
    }

    await mineOneContract(mnemonic, address, CONTRACT, threads, astBal, injBal);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
