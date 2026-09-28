import type { Plugin } from "vite";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

/**
 * `?inline` does not work on .wasm — Vite claims the extension for its own wasm
 * handling and Rollup then tries to parse the binary as JavaScript. So the
 * base64 is produced here instead, behind a virtual module.
 */
export function inlineZxingWasm(): Plugin {
  const id = "virtual:zxing-wasm-data-url";
  const resolved = `\0${id}`;
  return {
    name: "inline-zxing-wasm",
    resolveId: (source) => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null;
      const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
      return `export default "data:application/wasm;base64,${wasm.toString("base64")}"`;
    },
  };
}
