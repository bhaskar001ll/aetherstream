import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bhaskar.aetherstream',
  appName: 'AetherStream',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  }
};

export default config;
