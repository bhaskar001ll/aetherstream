# ⚡ AetherStream Dual-Engine
### Ultra-Fast Wireless (50–120+ MB/s) & Air-Gapped Optical File Transfer
**Author & Creator: Bhaskar**

[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](./package.json)
[![Tests](https://img.shields.io/badge/tests-78%20passing-brightgreen.svg)](./tests)
[![Security](https://img.shields.io/badge/encryption-AES--256--GCM-success.svg)](./wireless/crypto.ts)
[![License](https://img.shields.io/badge/license-Source--Available%20%2F%20Personal%20Use-red.svg)](#-license--proprietary-terms)

**AetherStream** is a high-performance, zero-cloud data transfer suite built to transfer files and data between phones, laptops, and PCs at physical hardware limits without storing anything on external servers.

It integrates **two distinct transfer engines** to cover every environment:

1. ⚡ **Ultra Wireless Mode**: High-throughput peer-to-peer Wi-Fi, LAN, and Hotspot transfer (**50 MB/s to 120+ MB/s**). Features instant 1-second QR pairing, radar discovery, 256KB chunk streaming over WebRTC DataChannel, adaptive flow control, and end-to-end AES-256-GCM encryption.
2. 👁️ **Air-Gapped Optical Mode**: True air-gap optical transfer. Transmits files purely as animated 2x2 multi-QR fountain codes from screen to camera without touching any Wi-Fi, Bluetooth, mobile network, or cable.

---

## ⚡ Transfer Engine Comparison

| Feature | ⚡ Ultra Wireless Mode | 👁️ Air-Gapped Optical Mode |
| :--- | :--- | :--- |
| **Typical Speed** | **50 – 120+ MB/s** (Local Wi-Fi / Hotspot) | 20 – 60 KB/s (Light frames) |
| **100 MB File** | **~1 – 2 seconds** | ~45 – 70 minutes |
| **1 GB Video File** | **~8 – 15 seconds** | ~8 – 14 hours |
| **Direction** | Phone ⇄ PC / PC ⇄ PC / Phone ⇄ Phone | Screen (Sender) ➜ Camera (Receiver) |
| **Pairing Time** | **< 1 second** (Interactive Radar, 1-Sec QR, PIN) | Point camera at screen |
| **Network Requirement**| Same Wi-Fi, Hotspot, or Internet fallback | **Zero Network** (100% Offline / Air-Gapped) |
| **Encryption & Privacy** | End-to-End AES-256-GCM + SHA-256 Checksums | Physical Air-Gap + Optional AES-256 |
| **Cloud Storage** | **None** (Direct Peer-to-Peer) | **None** (Direct Visual Light) |

---

## 📖 How To Use AetherStream (User Guide)

> 💡 **No App Installation Required**: AetherStream runs directly in any modern browser (Chrome, Edge, Safari, Firefox, Samsung Internet) on Android, Windows, macOS, Linux, and iOS.

---

### Mode 1: ⚡ Ultra Wireless Mode (High-Speed P2P)

Use this mode for rapid day-to-day transfers of large videos, photo galleries, archives, or text snippets between your phone and computer.

#### Step 1: Open the App
1. Open **AetherStream** in your browser on both devices (e.g., your PC and your Android phone or iPhone).
2. Ensure both devices are connected to the **same Wi-Fi network** or to a **Mobile Hotspot**.

#### Step 2: Connect Devices (Choose Any Method)
AetherStream provides 4 instant zero-setup connection methods:

* **Option A: Interactive Radar (Easiest)**
  - Look at the animated **Radar** screen. Nearby devices on the same network or cluster will appear with their device name and OS icon (💻 Windows, 📱 Android, 🍏 Mac/iOS).
  - Tap on the device card to initiate a direct connection.

* **Option B: 1-Second Instant QR Handshake (Recommended for Phone ↔ PC)**
  1. On your PC, click **"📱 1-Sec QR Pair"**. A pairing QR code will appear.
  2. On your Phone, tap **"📷 Scan QR"** (or use your phone's built-in camera app).
  3. Scan the QR code for a fraction of a second.
  4. The camera automatically turns off immediately, and both devices switch to gigabit WebRTC Wi-Fi data channels!

* **Option C: 6-Digit PIN Pairing**
  1. Click **"🔢 Enter PIN"**.
  2. Read the 6-digit code shown on the host device and enter it on the joining device.
  3. Connection is established instantly via secure signaling.

* **Option D: Direct Share Link**
  - Click **"📋 Copy Direct Pairing Link"** and send it to your other device via any messenger or email. Opening the link pairs the devices automatically.

#### Step 3: Send Files or Text
* **Sending Files**:
  1. Drag and drop any file or folder into the dropzone, or tap **"Browse Files"**.
  2. (Optional) Check **"🔒 AES-256-GCM Password Encryption"** and type a passphrase if you want zero-knowledge military-grade encryption.
  3. Click **"Send Now"**.
  4. Watch the live **Speedometer**, MB/s throughput counter, progress bar, and estimated time remaining (ETA).
  5. The receiving device automatically downloads the verified file directly to storage!

* **Sending Text & Clipboard Snippets**:
  1. Switch to the **"Text Snippet"** tab.
  2. Paste code, links, notes, or clipboard text.
  3. Tap **"Send Snippet"**. The receiver can copy it with 1 click.

---

### Mode 2: 👁️ Optical Air-Gap Mode (Zero-Network Light Stream)

Use this mode when operating in high-security, sensitive, or completely disconnected environments where Wi-Fi, Bluetooth, cellular data, or USB connections are prohibited or unavailable.

#### Step 1: Prepare the Sender (Broadcaster)
1. Open the **Broadcaster** or **Secure Broadcaster** module.
2. Select the file you want to transmit.
3. (Optional) Provide an encryption password for AES-256 protection.
4. The screen will begin displaying an animated **2x2 multi-QR grid** utilizing Luby Transform (LT) Fountain Codes.

#### Step 2: Receive on the Target Device (Scanner)
1. On the receiving device (e.g., phone or offline laptop with webcam), open the **Scanner** module or the standalone offline decoder.
2. Point the camera at the sender's screen.
3. The fountain decoder captures incoming light frames in any order. Even if frames drop or get delayed, the mathematical fountain code reconstructs the complete file seamlessly.
4. Once 100% of blocks are assembled, SHA-256 checksums verify data integrity bit-by-bit, and the file is saved locally.

---

## 🛠️ Tips for Maximum Speed & Hotspot Connectivity

1. **PC ↔ Android Hotspot Transfers**:
   - When connecting your PC to your phone's mobile hotspot, tap the camera permission prompt if requested. Modern browsers conceal private LAN IPs behind `.local` mDNS names; granting temporary permission lets the browser discover direct local host candidates, bypassing internet routing for maximum local hardware speed.
2. **Restricted Networks (Corporate / Public Wi-Fi)**:
   - AetherStream has built-in **STUN and TURN relay fallback** to guarantee that connections succeed even through symmetric NATs and strict corporate firewalls.
3. **Queue Safety & Large Files**:
   - With integrated 256KB chunk pipelines and 8MB buffer controls, transfers remain smooth without browser memory overflow or queue choking, even for multi-gigabyte files.

---

## 🛡️ Security & Privacy Architecture

- **Zero Cloud Storage**: All files travel directly device-to-device. No data is stored, cached, or seen by any intermediate server.
- **End-to-End Encryption**: Optional AES-256-GCM encryption with PBKDF2 (100,000 rounds) key derivation. If enabled, even network observers or signaling relays cannot decrypt your data.
- **Bit-for-Bit Integrity**: Cryptographic SHA-256 verification on every transmission prevents incomplete or corrupted files.
- **Ephemeral Signaling**: Peer discovery signals expire automatically within seconds and do not log file contents or metadata.

---

## 🔒 License & Proprietary Terms (Partial Open-Source)

> **Notice to Developers and Service Providers:**
> **AetherStream** is designed, developed, and maintained by **Bhaskar**.

The source code in this repository is made available under a **Source-Available / Personal Use License** for:
- Personal security auditing and code inspection.
- Educational study of WebRTC, Fountain Codes, and offline cryptographic protocols.
- Local offline development and personal non-commercial testing.

### 🚫 Commercial & Cloned Deployment Restrictions:
1. **No Public Hosting / No Clones**: You are **NOT permitted** to build, host, distribute, or operate a competing public web service, application, mirror, or commercial product using this source code, brand name, or derivatives without explicit prior written authorization from **Bhaskar**.
2. **Use the Official Service**: Anyone wishing to use AetherStream for everyday file sharing should access the official hosted service provided by Bhaskar.
3. **Trademark & Authorship**: The name *AetherStream*, its logos, dual-engine architecture, and visual design are proprietary to the author.

For licensing inquiries, custom enterprise integrations, or white-label solutions, contact the author.

---

**Crafted with precision by Bhaskar.**

