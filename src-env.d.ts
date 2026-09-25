/// <reference types="vite/client" />

/**
 * Emitted by the `inline-zxing-wasm` plugin in build/inline-zxing-wasm.ts:
 * the decoder wasm as a data: URI. Only standalone builds import it — served
 * builds resolve receive/wasm-url.ts instead and never touch this module.
 */
declare module "virtual:zxing-wasm-data-url" {
  const dataUrl: string;
  export default dataUrl;
}
