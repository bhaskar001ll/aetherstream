// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.

import { LTDecoder } from "../core/fountain";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../core/progress";
import { createDecodeWorker } from "../scanner/worker-factory";
import { NoSignalHintTimer } from "../core/no-signal";
import { DecodeWorkerPool } from "../core/worker-pool";
import { isSnippet, snippetText } from "../core/snippet";
import { fnv1a, parseFrame, streamIdentity, unpackFile, verifyFile } from "../core/protocol";
import { NO_SIGNAL_HINT_FRAME_BYTES, NO_SIGNAL_HINT_TX_FPS } from "../core/send-settings";
import { statusLine } from "../core/status-line";
import { requestScreenWakeLock } from "../core/wake-lock";
import { initInteractiveButtons } from "../core/interactive-buttons";
import { decryptPayload } from "../core/crypto";

initInteractiveButtons();

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const progressStatus = document.getElementById("progress-status")!;
const progressLabel = document.getElementById("progress-label")!;
const etaLabel = document.getElementById("eta-label")!;
const result = document.getElementById("result")!;
const metricsEl = document.getElementById("metrics")!;
const diagnosticsEl = document.getElementById("diagnostics") as HTMLDetailsElement | null;
const cfgWidth = document.getElementById("cfg-width") as HTMLSelectElement;
const cfgCapFps = document.getElementById("cfg-capfps") as HTMLSelectElement;
const cfgWorkers = document.getElementById("cfg-workers") as HTMLSelectElement;
const cameraActual = document.getElementById("camera-actual")!;

const decryptPanel = document.getElementById("decrypt-panel")!;
const decryptPassword = document.getElementById("decrypt-password") as HTMLInputElement;
const decryptBtn = document.getElementById("decrypt-btn") as HTMLButtonElement;
const decryptError = document.getElementById("decrypt-error")!;

const metric = (id: string) => document.getElementById(id)!;

// Nothing has decoded in this long → the sender is almost certainly too dense
// for this camera. Also the delay before a dismissed hint comes back, since
// dismissing it doesn't make the transfer start working.
const NO_SIGNAL_AFTER_MS = 10_000;

// Sliding window for the capture/decode fps metrics — the per-second rates in
// updateStats() are derived from this, so the window and the divisor can't
// drift apart.
const STATS_WINDOW_MS = 2000;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let streamKey = "";
let startTs = 0;
let captureGen = 0;
let done = false;
let settingsWired = false;
let statsTimer: ReturnType<typeof setInterval> | undefined;

const noSignal = new NoSignalHintTimer(NO_SIGNAL_AFTER_MS);
const pool = new DecodeWorkerPool(createDecodeWorker, (bytes) => onDecoded(bytes));
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

const videoUpload = document.getElementById("video-upload") as HTMLInputElement;
const uploadBtn = document.getElementById("upload-btn") as HTMLButtonElement;

uploadBtn.addEventListener("click", () => {
  videoUpload.click();
});

videoUpload.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  
  const url = URL.createObjectURL(file);
  
  if (file.type.startsWith('image/')) {
    preview.style.display = "block";
    metricsEl.style.display = "grid";
    if (diagnosticsEl) diagnosticsEl.style.display = "block";
    pool.resize(Number(cfgWorkers?.value || 2));
    
    const img = new Image();
    img.onload = () => {
      grab.width = img.width;
      grab.height = img.height;
      const ctx = grab.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height);
      pool.submit({ id: frameId++, buf: data.data.buffer, w: img.width, h: img.height }, [data.data.buffer]);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return;
  }
  
  // Video handling
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  
  video.src = url;
  video.muted = true;
  video.loop = true; // Loop so it keeps scanning if it misses something
  video.playbackRate = 0.5; // Smooth 50% speed to give decode workers ample time per frame
  
  pool.resize(Number(cfgWorkers?.value || 2));
  
  noSignal.cameraStarted(performance.now());
  captureGen++;
  
  await video.play().catch(() => undefined);
  scheduleFrame(captureGen);
  statsTimer = setInterval(updateStats, 500);
  await requestScreenWakeLock();
});

const { setStatus, showError } = statusLine(stats);

function restartButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => window.location.reload());
  return button;
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  if (pool.busyCount === pool.size) return; // all busy — drop frame, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  pool.submit({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [img.data.buffer]);
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (noSignal.frameDecoded()) result.replaceChildren();
  // streamIdentity() covers every header field that has to hold constant, not
  // just the session id — see the note on it in protocol.ts.
  const identity = streamIdentity(header);
  if (!decoder || streamKey !== identity) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    streamKey = identity;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressStatus.style.display = "flex";
  }
  decoder.addFrame(header.seq, block);
  updateProgressEstimate();

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    void finish(payload, ok, seconds);
  }
}

function updateProgressEstimate() {
  if (!decoder) return;
  const elapsed = Math.max(0, (performance.now() - startTs) / 1000);
  const estimate = estimateTransferProgress(
    decoder.k,
    decoder.framesNew,
    elapsed,
    decoder.solvedCount,
  );
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent =
    `${shownPercent}% · ${decoder.solvedCount}/${decoder.k} blocks`;
  // Held back for the first few frames — a two-frame sample reads wildly wrong.
  const rate = decoder.framesNew >= 4 ? ` · ${goodputKbs(elapsed).toFixed(1)} KB/s` : "";
  etaLabel.textContent =
    (estimate.etaSeconds === undefined
      ? estimate.phase === "decoding"
        ? `${decoder.framesNew} frames · decoding`
        : "Estimating time…"
      : `About ${formatDuration(estimate.etaSeconds)} · ${decoder.framesNew} frames`) + rate;
}

/** Payload KB/s, discounting the frames the fountain spends on overhead. That
 *  discount is k-dependent — assuming a flat 1.18 over-reported small transfers
 *  by up to 2×, because a short stream needs far more redundancy per block. */
function goodputKbs(elapsed: number): number {
  if (!decoder) return 0;
  return (
    (decoder.framesNew * decoder.blockLen) /
    expectedFountainOverhead(decoder.k) /
    1024 /
    Math.max(0.1, elapsed)
  );
}

async function finish(container: Uint8Array, hashOk: boolean, seconds: number) {
  done = true;
  captureGen++;
  // Tear the whole capture pipeline down: the camera, the stats timer, and the
  // decode pool. Each worker holds its own ~940 KB zxing WASM instance, which
  // is worth reclaiming on a phone the moment the last frame is in.
  video.pause();
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  preview.style.display = "none";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);
    if (!(await verifyFile(file))) throw new Error("The recovered file failed SHA-256 verification.");

    if (file.type === "application/x-aether-encrypted") {
      result.replaceChildren(); // Clear default message
      decryptPanel.hidden = false;
      
      decryptBtn.onclick = async () => {
        try {
          decryptError.hidden = true;
          decryptBtn.disabled = true;
          decryptBtn.textContent = "Decrypting...";
          
          const innerContainer = await decryptPayload(decryptPassword.value, file.bytes);
          
          decryptPanel.hidden = true;
          decryptBtn.disabled = false;
          decryptBtn.textContent = "Decrypt";
          decryptPassword.value = "";
          
          // Re-enter the finish pipeline with the decrypted container
          void finish(innerContainer, true, seconds);
          
        } catch (err) {
          decryptError.hidden = false;
          decryptBtn.disabled = false;
          decryptBtn.textContent = "Decrypt";
        }
      };
      return;
    }

    // The container carries its own media type, so the receiver never has to be
    // told in advance whether a file or a text snippet is coming.
    const rate = (container.length / 1024 / seconds).toFixed(1);
    const gzipNote = file.compression === "gzip" ? "gzip decompressed · " : "";
    if (isSnippet(file)) {
      progressLabel.textContent = "100% · text recovered";
      setStatus(`text in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`);
      showSnippet(snippetText(file));
      return;
    }

    progressLabel.textContent = "100% · file recovered";
    const kb = Math.round(file.bytes.length / 1024);
    setStatus(`${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`);
    const heading = document.createElement("div");
    heading.className = "done";
    heading.textContent = "Transfer Complete!";
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const download = document.createElement("a");
    download.className = "download";
    download.href = url;
    download.download = file.name;
    download.textContent = `Save ${file.name}`;
    const actions = document.createElement("div");
    actions.className = "note-actions";
    actions.append(download, restartButton("Receive another"));
    result.replaceChildren(heading, actions);
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "received";
      image.alt = `Received file preview: ${file.name}`;
      image.src = url;
      result.append(image);
    } else if (file.type.startsWith("video/")) {
      const videoEl = document.createElement("video");
      videoEl.className = "received";
      videoEl.controls = true;
      videoEl.src = url;
      videoEl.style.width = "100%";
      videoEl.style.marginTop = "15px";
      videoEl.style.borderRadius = "8px";
      result.append(videoEl);
    }
  } catch (error) {
    // Everything is already torn down by this point, so the only way back to a
    // live receiver is a reload. Offer it: a failed checksum used to leave the
    // page dead with nothing but an error string on it.
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    showError(error instanceof Error ? error.message : String(error));
    const heading = document.createElement("div");
    heading.className = "failed";
    heading.textContent = "Transfer failed";
    const detail = document.createElement("p");
    detail.className = "received-note";
    detail.textContent =
      "Nothing usable came out of that stream. Restart the sender, then scan it again — " +
      "a partial transfer costs nothing but the time.";
    result.replaceChildren(heading, detail, restartButton("Try again"));
  }
}

/**
 * Ten seconds of camera and not one decoded frame.
 *
 * Both real fixes are on the SENDER, which is the non-obvious part — someone
 * staring at a blank receiver reaches for the phone. The defaults (2953 bytes
 * per frame at 60 fps) are tuned for a close-range phone-to-phone demo and are
 * exactly the combination that fails on an ordinary monitor at arm's length.
 *
 * Dismissing it only re-arms the countdown: nothing about tapping the button
 * makes frames start arriving, so if the transfer is still dead ten seconds
 * later the advice is still the advice. It stops for good on the first frame
 * that parses, which is the only thing that actually means it worked.
 */
function showNoSignalHint() {
  const panel = document.createElement("div");
  panel.className = "no-signal";
  // It appears on a timer rather than in response to anything the user did,
  // which is exactly what a live region is for.
  panel.setAttribute("role", "status");

  const heading = document.createElement("strong");
  heading.textContent = "Nothing decoded yet — try this";
  const list = document.createElement("ul");
  for (const line of [
    `On the sender, open Transfer settings and drop bytes / frame to ${NO_SIGNAL_HINT_FRAME_BYTES}.`,
    `Still nothing? Drop the sender's tx fps to ${NO_SIGNAL_HINT_TX_FPS} as well.`,
    "Fill this camera's view with the code, and prop the phone against something — autofocus hunting from hand tremor is the usual culprit.",
    "Turn the sending screen's brightness all the way up.",
  ]) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "text-button no-signal-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    noSignal.dismiss(performance.now());
    result.replaceChildren();
  });

  panel.append(heading, list, dismiss);
  result.replaceChildren(panel);
}

/** Nothing is persisted: the text lives here until the page is closed. */
function showSnippet(text: string) {
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Text received";

  const body = document.createElement("textarea");
  body.className = "received-note";
  body.value = text;
  body.readOnly = true;
  body.style.width = "100%";
  body.style.minHeight = "150px";
  body.style.padding = "10px";
  body.style.borderRadius = "8px";
  body.style.background = "#1e293b";
  body.style.color = "#f8fafc";
  body.style.border = "1px solid #334155";
  body.style.marginTop = "10px";

  const actions = document.createElement("div");
  actions.className = "note-actions";
  actions.style.display = "flex";
  actions.style.gap = "10px";
  actions.style.marginTop = "10px";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "text-button primary";
  copy.style.background = "#3b82f6";
  copy.style.color = "white";
  copy.style.padding = "0.5rem 1rem";
  copy.style.borderRadius = "6px";
  copy.textContent = "Copy text";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied!";
      setTimeout(() => { copy.textContent = "Copy text"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy, restartButton("Receive another"));

  result.replaceChildren(heading, body, actions);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  const perSecond = (a: number[]) => a.length / (STATS_WINDOW_MS / 1000);
  metric("m-cap").textContent = perSecond(captureTimes).toFixed(0);
  metric("m-dec").textContent = perSecond(decodeTimes).toFixed(1);
  if (noSignal.tick(now)) showNoSignalHint();
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  updateProgressEstimate();
  metric("m-rate").textContent = `${goodputKbs(elapsed).toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
