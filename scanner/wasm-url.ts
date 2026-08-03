// Served builds fetch the 940 KB decoder wasm as a separate asset, which the
// service worker precaches. Standalone builds swap this for wasm-url.inline.ts.
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

export default wasmUrl;
