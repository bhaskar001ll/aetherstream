/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_TURN_SHARED_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Emitted by the `inline-zxing-wasm` plugin in build/inline-zxing-wasm.ts:
 * the decoder wasm as a data: URI. Only standalone builds import it — served
 * builds resolve receive/wasm-url.ts instead and never touch this module.
 */
declare module "virtual:zxing-wasm-data-url" {
  const dataUrl: string;
  export default dataUrl;
}
