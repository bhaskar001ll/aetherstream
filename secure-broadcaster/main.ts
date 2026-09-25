// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.

import QRCode from "qrcode";
import { fitQrDisplaySize } from "../core/display";
import { rasterizeQr } from "../core/qr-raster";
import { formatBytes } from "../core/format";
import {
  MAX_SOURCE_BLOCKS,
  blockLength,
  fitsInOneStream,
  minimumFrameBytes,
  smallestSufficientFrameSize,
  sourceBlockCount,
} from "../core/frame-capacity";
import { LTEncoder } from "../core/fountain";
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_LABEL, packSnippet } from "../core/snippet";
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  fnv1a,
  packFile,
  packFrame,
  type FrameHeader,
  type PackedOpticalFile,
} from "../core/protocol";
import { encryptPayload } from "../core/crypto";
import { statusLine } from "../core/status-line";
import { requestScreenWakeLock } from "../core/wake-lock";
import { initInteractiveButtons } from "../core/interactive-buttons";

initInteractiveButtons();

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 3;

// `npm run demo` (vite --mode demo). Locks the sender to the two bundled
// payloads so the app can be left running in front of strangers without
// handing them a file picker into the host machine.
const DEMO = import.meta.env.VITE_DEMO === "1";

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const specs = document.getElementById("specs");
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const filePickerLabel = document.getElementById("file-picker-label")!;
const toolTitle = document.getElementById("tool-title");
const snippetText = document.getElementById("snippet-text") as HTMLTextAreaElement;
const snippetLabel = document.getElementById("snippet-label")!;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const paneFile = document.getElementById("pane-file")!;
const paneSnippet = document.getElementById("pane-snippet")!;
const paneDemo = document.getElementById("pane-demo")!;
const modePicker = document.getElementById("mode-picker")!;
const modeBtnFile = document.getElementById("mode-btn-file") as HTMLButtonElement;
const modeBtnSnippet = document.getElementById("mode-btn-snippet") as HTMLButtonElement;
let currentActiveMode: "file" | "snippet" | null = null;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const cfgGrid = document.getElementById("cfg-grid") as HTMLSelectElement;
const securePanel = document.getElementById("secure-panel") as HTMLDivElement;
const securePassword = document.getElementById("secure-password") as HTMLInputElement;

let selectedFile: {
  name: string;
  size: number;
  payload: Uint8Array;
  compression: "none" | "gzip";
  transmittedSize: number;
} | null = null;
let currentSession: {
  sessionId: number;
  blockLen: number;
  nextSeq: number;
  file: typeof selectedFile;
} | null = null;
let generation = 0; // bumped on every restart; stale loops see it and die
let resizeDisplay: (() => void) | null = null;

const specsLine = specs ? statusLine(specs) : null;
const setStatus = specsLine ? specsLine.setStatus : () => {};

/**
 * Errors also hide the stage — a stale QR stream pulsing away under a
 * rejection message reads as "still working".
 *
 * Callers decide whether the pick survives. A file rejected on size is gone;
 * a stream that can't start at the current bytes/frame is not, because turning
 * that setting back up is the fix.
 */
function showError(message: string): void {
  stage.hidden = true;
  if (specsLine) specsLine.showError(message);
  else alert(message);
}

function currentMode(): "file" | "snippet" | null {
  return currentActiveMode;
}

function updateStartBtn() {
  const mode = currentMode();
  let enabled = false;
  if (mode === "file") {
    enabled = !!cfgFile.files?.length;
  } else if (mode === "snippet") {
    enabled = snippetText.value.trim().length > 0;
  }
  
  if (enabled) {
    enabled = securePassword.value.length > 0;
  }
  
  startBtn.disabled = !enabled;
}

/** Switching what we're sending kills any stream in flight and clears the stage. */
function applyMode(): void {
  generation++;
  selectedFile = null;
  stage.hidden = true;

  if (DEMO) {
    modePicker.hidden = true;
    paneFile.hidden = true;
    paneSnippet.hidden = true;
    paneDemo.hidden = false;
    setStatus("Choose a demo payload to begin");
    return;
  }

  const mode = currentMode();
  paneFile.style.display = mode !== "file" ? "none" : "";
  paneSnippet.style.display = mode !== "snippet" ? "none" : "";
  securePanel.style.display = mode ? "" : "none";
  
  let statusText = "Choose a mode above to begin";
  if (mode === "snippet") statusText = "Paste or type some text and enter a password to begin";
  else if (mode === "file") statusText = "Choose a file and enter a password to begin";
  setStatus(statusText);
  
  if (mode === "file") {
    modeBtnFile.className = 'mode-card primary';
    modeBtnSnippet.className = 'mode-card secondary';
  } else if (mode === "snippet") {
    modeBtnFile.className = 'mode-card secondary';
    modeBtnSnippet.className = 'mode-card primary';
  } else {
    modeBtnFile.className = 'mode-card secondary';
    modeBtnSnippet.className = 'mode-card secondary';
  }

  updateStartBtn();
}

/**
 * The one path from "user picked something" to a running stream.
 *
 * Kills any stream in flight, then packs the payload; a selection that lands
 * mid-pack (the generation guard) or fails to pack (throw → showError) leaves
 * the page idle rather than streaming something stale. Every way of choosing a
 * payload goes through here so the guard can't be subtly wrong in one copy.
 */
async function startSelection(
  status: string,
  prepare: () => Promise<{ name: string; size: number; packed: PackedOpticalFile }>,
): Promise<void> {
  const selectionGeneration = ++generation;
  selectedFile = null;
  stage.hidden = true;
  setStatus(status);
  try {
    let { name, size, packed } = await prepare();
    
    setStatus(`encrypting payload...`);
    const password = securePassword.value;
    if (!password) throw new Error("Encryption password is required.");
    const ciphertext = await encryptPayload(password, packed.container);
    packed = await packFile("encrypted.bin", "application/x-aether-encrypted", ciphertext);
    name = "Encrypted Payload";
    size = packed.originalSize;
    
    if (selectionGeneration !== generation) return;
    selectedFile = {
      name,
      size,
      payload: packed.container,
      compression: packed.compression,
      transmittedSize: packed.transmittedSize,
    };
    await startStream(true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

/** Demo payloads ship in public/, so they sit at the site root beside /broadcaster/. */
async function selectDemo(fileName: string): Promise<void> {
  await startSelection(`loading ${fileName}…`, async () => {
    const response = await fetch(`../${fileName}`);
    if (!response.ok) throw new Error(`could not load ${fileName} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { name: fileName, size: bytes.length, packed: await packFile(fileName, "image/png", bytes) };
  });
}

async function selectFile(): Promise<void> {
  const file = cfgFile.files?.[0];
  if (!file) return;
  await startSelection(`preparing ${file.name}…`, async () => {
    // Checked here, off File.size, rather than after reading the bytes: a file
    // well past the limit should be refused instantly instead of after the
    // browser has spent time and memory materialising it. Name the actual size —
    // "too large" without a number leaves you guessing by how much.
    if (file.size === 0) {
      throw new Error(`${file.name} is empty — there is nothing to send.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`${file.name} is ${formatBytes(file.size)}, over the ${MAX_FILE_LABEL} limit.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { name: file.name, size: file.size, packed: await packFile(file.name, file.type, bytes) };
  });
}

async function selectSnippet(): Promise<void> {
  await startSelection("preparing text snippet…", async () => {
    const packed = await packSnippet(snippetText.value);
    return { name: "Text snippet", size: packed.originalSize, packed };
  });
}

async function main() {
  // Apply mobile-specific defaults before any listeners or states are initialized
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
  if (isMobile) {
    cfgGrid.value = "1x1";
    cfgFps.value = "20";
    cfgBytes.value = "1850";
    cfgEcc.value = "L";
  }

  // Both bounds come from MAX_SNIPPET_BYTES so they can't drift apart. maxLength
  // counts UTF-16 units and the real check counts UTF-8 bytes, which are never
  // fewer — so this is a loose guard and packSnippet() remains authoritative.
  snippetText.maxLength = MAX_SNIPPET_BYTES;
  snippetLabel.textContent = `Text to send · up to ${MAX_SNIPPET_LABEL}`;
  filePickerLabel.textContent = `Any file · up to ${MAX_FILE_LABEL}`;

  if (DEMO) {
    document.querySelector(".mode-badge")!.textContent = "Demo";
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-demo]")) {
      button.addEventListener("click", () => void selectDemo(button.dataset.demo!));
    }
  } else {
    cfgFile.addEventListener("change", updateStartBtn);
    snippetText.addEventListener("input", updateStartBtn);
    securePassword.addEventListener("input", updateStartBtn);
    
    startBtn.addEventListener("click", () => {
      if (currentMode() === "file") {
        void selectFile();
      } else {
        void selectSnippet();
      }
    });
    
    modeBtnFile.addEventListener("click", () => {
      currentActiveMode = "file";
      applyMode();
    });
    modeBtnSnippet.addEventListener("click", () => {
      currentActiveMode = "snippet";
      applyMode();
    });
  }
  applyMode();
  window.addEventListener("resize", () => resizeDisplay?.());
  for (const el of [cfgFps, cfgBytes, cfgEcc, cfgGrid]) {
    el.addEventListener("input", () => void startStream());
  }
  cfgSize.addEventListener("input", () => {
    if (resizeDisplay) resizeDisplay();
  });
  await requestScreenWakeLock();
}

/** Only on a fresh pick — a settings change restarts the stream too, and
 *  yanking the page down every time you nudge tx fps is worse than useless. */
function scrollStageIntoView() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });
}

async function startStream(revealStage = false) {
  const gen = ++generation;
  resizeDisplay = null;
  if (!selectedFile) {
    setStatus(
      currentMode() === "snippet" ? "Paste or type some text to begin" : "Choose a file to begin",
    );
    return;
  }
  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
  if (gen !== generation) return; // superseded while fetching
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);

  const blockLen = blockLength(frameBytes);
  let sessionId: number;
  let nextSeq = 0;

  if (currentSession && currentSession.file === selectedFile && currentSession.blockLen === blockLen) {
    sessionId = currentSession.sessionId;
    nextSeq = currentSession.nextSeq;
  } else {
    sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  }
  currentSession = { sessionId, blockLen, nextSeq, file: selectedFile };

  // Keep selectedFile on this path — raising bytes/frame back up is the fix,
  // and dropping the pick would hide that.
  if (!fitsInOneStream(payload.length, frameBytes)) {
    // Name a setting that is actually in the dropdown, not the bare minimum.
    const offered = [...cfgBytes.options].map((option) => Number(option.value));
    const suggestion =
      smallestSufficientFrameSize(payload.length, offered) ?? minimumFrameBytes(payload.length);
    showError(
      `${formatBytes(payload.length)} needs ` +
        `${sourceBlockCount(payload.length, frameBytes).toLocaleString()} blocks at ` +
        `${frameBytes} bytes per frame, and a frame can only number ` +
        `${MAX_SOURCE_BLOCKS.toLocaleString()} of them. ` +
        `Raise bytes / frame to ${suggestion} or more.`,
    );
    return;
  }
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  let version: number | undefined; // locked after the first frame
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: (ImageData | ImageData[])[] = [];
  stage.hidden = false;

  const isGrid = cfgGrid?.value === "2x2";
  const gridFactor = isGrid ? 2 : 1;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = (modules + 2 * MARGIN) * gridFactor;
    const containerWidth = stage.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const stageStyle = getComputedStyle(stage);
    const horizontalChrome =
      Number.parseFloat(stageStyle.paddingLeft) +
      Number.parseFloat(stageStyle.paddingRight) +
      Number.parseFloat(stageStyle.borderLeftWidth) +
      Number.parseFloat(stageStyle.borderRightWidth);
    const cssBudget = fitQrDisplaySize(
      window.innerWidth,
      window.innerHeight,
      containerWidth,
      displayPx,
      horizontalChrome,
    );
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
  };

  const createSingleQr = () => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    if (currentSession) currentSession.nextSeq = nextSeq;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
    }
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
    return new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  };

  const makeFrame = (): ImageData | ImageData[] => {
    if (isGrid) {
      // 2x2 grid
      const qrs = [createSingleQr(), createSingleQr(), createSingleQr(), createSingleQr()];
      
      if (!resizeDisplay) {
        sizeCanvas();
        resizeDisplay = sizeCanvas;
        if (revealStage) scrollStageIntoView();
        setStatus(`4x Grid · ${txFps} FPS · ${frameBytes} bytes/frame · V${version} · ECC ${ecc}`);
      }
      return qrs;
    } else {
      const single = createSingleQr();
      if (!resizeDisplay) {
        sizeCanvas();
        resizeDisplay = sizeCanvas;
        if (revealStage) scrollStageIntoView();
        setStatus(`Single · ${txFps} FPS · ${frameBytes} bytes/frame · V${version} · ECC ${ecc}`);
      }
      return single;
    }
  };

  /**
   * Refill the lookahead, generating at most `max` frames per call.
   *
   * Called once up front to fill the queue, then once per tick() — the only
   * thing that drains it. Self-scheduling on `setTimeout(pump, 0)` instead cost
   * ~250 wake-ups a second doing nothing once the queue was full. Capping at
   * one frame per tick keeps the amortisation that gave us: a rAF callback
   * never pays for more than the single frame it just consumed.
   */
  let generatorFailed = false;
  const pump = (max = LOOKAHEAD) => {
    if (generatorFailed || gen !== generation) return;
    try {
      for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) queue.push(makeFrame());
    } catch (err) {
      // e.g. frame bytes over capacity for the chosen ECC level
      generatorFailed = true;
      showError(err instanceof Error ? err.message : String(err));
    }
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    // generatorFailed means no frame will ever be produced again, so stop the
    // rAF loop rather than spinning on an empty queue until a settings change.
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const item = queue.shift();
    pump(1);
    if (!item) {
      nextAt = now + interval;
      return;
    }
    const ctxStaging = staging.getContext("2d")!;
    if (Array.isArray(item)) {
       const size = item[0].width;
       ctxStaging.putImageData(item[0], 0, 0);
       ctxStaging.putImageData(item[1], size, 0);
       ctxStaging.putImageData(item[2], 0, size);
       ctxStaging.putImageData(item[3], size, size);
    } else {
       ctxStaging.putImageData(item, 0, 0);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval; // fell behind — don't burst
  };
  requestAnimationFrame(tick);
}

void main();
