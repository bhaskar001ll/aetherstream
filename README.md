# AetherStream by Bhaskar

**AetherStream** is an advanced, offline optical data transfer tool. It allows you to transmit files or text from one device's screen to another device's camera using high-speed, Fountain-coded animated QR codes. No network connection, pairing, or cloud storage is required between the two devices. The data travels purely as light!

Designed and authored by **Bhaskar**.

## 🌟 Key Features

- **True Air-Gap Security**: Data never touches a network interface. It is transmitted purely optically via your screen.
- **2x2 Multi-QR Grid Upgrade**: Broadcasts four parallel QR codes simultaneously per frame, massively increasing data throughput and transfer speed.
- **Fountain Codes (Luby Transform)**: Reconstructs files seamlessly even if camera frames are dropped or the devices are briefly out of sync.
- **Progressive Web App (PWA)**: Works entirely offline once loaded.

## 📱 Android App (Standalone Offline APK)

For completely offline optical file transfer on Android (without any network connection or web server), use the standalone Android app:
- 📦 **Download APK**: [`AetherStream.apk`](./AetherStream.apk)

*Note: For without network file transfer in Android, use this APK.*

## 🚀 Installation & Requirements

### System Requirements
- **Node.js**: v20 or higher is recommended (the project uses modern ES modules and Vite plugins).
- **npm**: v9 or higher.
- A modern web browser with camera access permissions.

### Setup Instructions

1. **Clone the Repository** (or extract the source code):
   ```bash
   git clone https://github.com/bhaskar001ll/aetherstream.git
   cd aetherstream
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Start the Development Server**:
   ```bash
   npm run dev
   ```
   The server will start (usually on `https://localhost:5173/` or similar). Notice that it runs securely (`https://`), which is required for browsers to allow camera access. 

## 🛠️ Operating Instructions

You will need two devices: a **Sender** (usually a laptop or tablet with a large screen) and a **Receiver** (usually a smartphone with a good camera).

### On the Sender (Laptop)
1. Open the provided `Local` or `Network` link in your browser.
2. Click on **SEND MODE**.
3. Choose the layout: **4x Grid (2x2)** is recommended for high speed.
4. Select a file or paste a text snippet.
5. Turn up your screen brightness to maximum for the best transmission results.

### On the Receiver (Smartphone)
1. Ensure your smartphone is connected to the same local Wi-Fi network as the sender (only to access the web app UI, the actual transfer happens via the camera).
2. Open the `Network` link shown in the terminal (e.g., `https://192.168.x.x:5173/`).
3. Accept the self-signed SSL certificate warning if prompted (required for camera access).
4. Click on **RECEIVE MODE**.
5. Tap **Start camera** and point it at the flashing QR codes on the Sender's screen.
6. The transfer will begin automatically. Keep the QR codes centered in the frame!

## 📜 Authorship
Created and maintained by Bhaskar.
