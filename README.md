# AetherStream Dual-Engine by Bhaskar
### Ultra-Fast Wireless (50–120+ MB/s) & Air-Gapped Optical Transfer

**AetherStream** is a high-performance, private, zero-cloud data transfer suite. It provides **two distinct transfer engines** to cover every operational scenario:

1. ⚡ **Ultra Wireless Mode (NEW)**: High-speed peer-to-peer Wi-Fi & Bluetooth transfer (**50 MB/s to 120+ MB/s**). Solves the optical screen/camera asymmetry bottleneck, allowing instantaneous Phone ↔ PC transfers with 1-second pairing, local radar discovery, and AES-256-GCM encryption.
2. 👁️ **Air-Gapped Optical Mode**: Bhaskar's original true air-gap light transfer. Transmits files purely as animated 2x2 multi-QR fountain codes from screen to camera without touching any network interface.

Designed and authored by **Bhaskar**.

---

## ⚡ Mode Comparison

| Feature | ⚡ Ultra Wireless Mode (NEW) | 👁️ Optical Air-Gap Mode |
| :--- | :--- | :--- |
| **Transfer Speed** | **50 – 120+ MB/s** (Gigabit Wi-Fi) | 20 – 60 KB/s (Light frames) |
| **100 MB File Time** | **~1 – 2 seconds** | ~45 – 70 minutes |
| **1 GB Video Time** | **~8 – 15 seconds** | ~8 – 14 hours |
| **Phone ↔ PC Support** | Seamless (both directions) | Limited by screen size / webcam focus |
| **Pairing Time** | **0.5s** (1-Sec QR, Radar, or BLE) | Continuous camera alignment |
| **Network Used** | Local Wi-Fi / Hotspot (No Internet) | Zero network (Pure light) |
| **Security** | End-to-End AES-256-GCM + SHA-256 | Physical Air-Gap + Optional AES |

---

## 🌟 Key Features

### 1. Ultra Wireless Mode (Wi-Fi + Bluetooth + WebRTC)
- **Extreme Speed**: Pipelined 64KB binary chunk streaming over WebRTC DataChannel (SCTP) with dynamic flow control.
- **Tri-Modal Zero-Config Discovery**:
  - **Local Radar**: Interactive animated radar canvas automatically discovers other phones and PCs on the same local network.
  - **1-Second Instant QR Handshake**: Display 1 static QR code on screen; scan it once for 0.5s with camera to connect; camera immediately closes and data transfers over gigabit Wi-Fi.
  - **Web Bluetooth**: Scan and pair nearby Bluetooth Low Energy devices.
- **Large File Streaming**: Streams directly to disk via the File System Access API without filling system RAM.
- **Live Speedometer**: Real-time MB/s throughput meter, byte counter, ETA, and progress bar.
- **Text & Clipboard Sync**: 1-click sharing of text snippets, notes, and code between devices.
- **End-to-End Encryption**: Optional AES-256-GCM password encryption with PBKDF2 key derivation (100k iterations).
- **Cryptographic Verification**: Every file verified bit-for-bit with SHA-256 checksums before saving.

### 2. Optical Air-Gap Mode (Light Stream)
- **True Air-Gap**: Data travels purely as light from screen to camera.
- **2x2 Multi-QR Grid**: Displays 4 parallel QR codes simultaneously per frame.
- **Fountain Codes (Luby Transform)**: Reconstructs files seamlessly even if camera frames drop.
- **Mass Optical Broadcast (1:N)**: Broadcast files from a single PC or display to thousands of receiving phones simultaneously with zero network usage.

### 3. Upgraded Android Native Application (v0.3.0)
- **Capacitor Native Android**: Complete native Android workspace in [`android/`](./android) with Camera, Local Wi-Fi, and Bluetooth permissions configured.
- **Full Dual-Engine Support**: Seamlessly switch between Ultra Wireless (50–120+ MB/s) and Optical Air-Gap modes in the mobile app.
- **Sync Web Assets**:
  ```bash
  npm run cap:sync    # Rebuilds web bundle and syncs to Android assets
  ```
- **Automated Cloud APK Builds**: GitHub Actions workflow automatically compiles `app-debug.apk` on every push and GitHub Release.

---

## 🚀 Installation & Running

### Requirements
- **Node.js**: v20 or higher.
- **npm**: v9 or higher.
- A modern web browser (Chrome, Edge, Safari, Firefox).

### Quick Start

1. **Clone & Install**:
   ```bash
   git clone https://github.com/bhaskar001ll/aetherstream.git
   cd aetherstream
   npm install
   ```

2. **Start the Application**:
   ```bash
   npm run dev
   ```

3. **Accessing from Phone and PC**:
   - On PC: Open `https://localhost:5173/` or `https://localhost:5173/wireless/`
   - On Phone: Connect to the same Wi-Fi, open the Network URL shown in the terminal (e.g. `https://10.0.118.90:5173/wireless/`)
   - Tap through the local self-signed SSL certificate notice once.
   - Devices will immediately appear on each other's Radar, or tap **1-Sec QR Pair** to connect instantly!

4. **Run Tests**:
   ```bash
   npm test
   ```
   *(Executes all 78 unit tests covering fountain codes, optical frames, wireless crypto, and protocol throughput)*

---

## 🌐 Deploy to Vercel & Cloud Platforms

AetherStream is built to be deployed anywhere as a **zero-install web application** so anyone can use it directly in their mobile or desktop browser!

### Option A: Deploy on Vercel (1-Click & Recommended)

1. Push your code to GitHub:
   ```bash
   git add .
   git commit -m "Add Ultra Wireless & Vercel deployment"
   git push origin main
   ```
2. Go to [vercel.com](https://vercel.com) and click **"Add New Project"**.
3. Import your `aetherstream` repository.
4. Vercel automatically detects the configuration via [`vercel.json`](./vercel.json):
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
5. Click **Deploy**. Your app is live at `https://your-project.vercel.app`!

### Option B: Deploy via Vercel CLI
```bash
npm i -g vercel
vercel
```

### Option C: Deploy on Netlify / Cloudflare Pages / GitHub Pages
- **Build Command**: `npm run build`
- **Publish Directory**: `dist`
- Because AetherStream includes public Google STUN servers and universal direct URL/QR pair links, WebRTC direct P2P connections work even on 100% static hosting!

---

## 📱 How Anyone Can Use It In The Browser (Zero App Install)

1. **Sender (PC or Phone)** opens your deployed Vercel URL (e.g. `https://your-project.vercel.app/wireless/`).
2. Clicks **"📱 1-Sec QR Pair"**.
3. **Receiver** simply points their phone camera at the screen:
   - The phone's camera detects the link and opens the web app.
   - The connection is established automatically via WebRTC P2P!
   - (Or click **"📋 Copy Direct Pairing Link"** and send it via WhatsApp, Slack, or Email).
4. Drag & drop files or type text to stream directly between devices with AES-256-GCM encryption at maximum network speed.

---

## 📜 Authorship & License
- **Author**: Bhaskar
- **License**: MIT
