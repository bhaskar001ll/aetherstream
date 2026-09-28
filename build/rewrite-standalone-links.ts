import type { Plugin } from "vite";

// The header brand, byte-identical to the single line in send/index.html and
// receive/index.html — the inline SVG is what lets the standalone pages keep
// the logo with no external reference. A drift here fails the build (below).
const BRAND_INNER =
  '<svg class="brand-logo" viewBox="0 0 543 554.1" fill="currentColor" aria-hidden="true">' +
  '<g transform="translate(-241,789) scale(0.1,-0.1)">' +
  '<path d="M2410 6513 l0 -1378 103 101 c540 531 1324 986 1984 1153 402 102 850 95 1268 -21 ' +
  "529 -146 1300 -581 1860 -1050 175 -146 212 -184 199 -205 -37 -63 -502 -432 -754 -600 " +
  "-969 -644 -1785 -844 -2590 -634 -667 174 -1376 581 -1947 1118 l-123 115 0 -1382 0 -1381 " +
  "1478 4 c1291 3 1491 5 1588 20 1345 194 2240 1124 2355 2446 17 195 7 620 -19 786 -192 " +
  '1236 -1030 2069 -2262 2249 -217 32 -411 36 -1772 36 l-1368 0 0 -1377z"/>' +
  '<path d="M4945 5906 c-300 -68 -532 -287 -611 -577 -25 -89 -25 -289 0 -378 141 -513 724 ' +
  "-749 1179 -477 405 242 503 778 209 1148 -100 125 -258 229 -417 273 -82 22 -282 29 -360 " +
  '11z"/></g></svg>Muffin Optical Transfer';

/**
 * A standalone file has no siblings, so links to the other pages are dead ends.
 * Rewrites are exact-match and `required` ones throw when they miss, so editing
 * the markup breaks the build rather than silently shipping broken links.
 */
export function rewriteStandaloneLinks(): Plugin {
  const rules: { from: string; to: string; required: boolean }[] = [
    {
      from: `<a class="brand" href="../">${BRAND_INNER}</a>`,
      to: `<span class="brand">${BRAND_INNER}</span>`,
      required: true,
    },
    {
      from: 'Open <a href="../scanner/">Receive</a> on the other device.',
      to: "Open the standalone receiver on the other device.",
      required: false,
    },
    {
      // A single file has no siblings to load a favicon from, and leaving the
      // link in would be the one external reference in a page whose whole point
      // is having none.
      from: '<link rel="icon" href="../muffin_logo.svg" type="image/svg+xml" />',
      to: "",
      required: true,
    },
  ];
  return {
    name: "rewrite-standalone-links",
    transformIndexHtml(html) {
      for (const { from, to, required } of rules) {
        if (!html.includes(from)) {
          if (required) throw new Error(`standalone link rewrite missed its target: ${from}`);
          continue;
        }
        html = html.replaceAll(from, to);
      }
      return html;
    },
  };
}
