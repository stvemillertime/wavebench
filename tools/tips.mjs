// Hover-help coverage: lists the controls in index.html's static markup that have no data-tip (or title, which the
// page moves into data-tip), so nothing reaches the status bar when they're hovered. Fails on any gap; --warn only lists
// them. --strict is accepted too (the default).
//   node tools/tips.mjs [--strict | --warn]
// Controls built by script (transform grid, library cards, bank rows...) aren't seen here: give their templates a
// data-tip too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const at = html.indexOf("<body"), body = html.slice(at, html.indexOf("<script", at)), first = html.slice(0, at).split("\n").length - 1;
const strict = !process.argv.includes("--warn");

// a tip on any element still open around a control (its <label>, its .row...) covers it, the same as the page's
// closest("[data-tip]") does
const tipped = /\s(data-tip|title)="[^"]+"/;
const skip = [/\shidden[\s>]/, /type="file"/, /type="hidden"/, /aria-hidden="true"/];
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "source", "wbr", "col", "area", "embed", "track"]);
const CONTROL = new Set(["button", "input", "select", "textarea", "canvas"]);
const lines = body.split("\n"), misses = [], stack = []; // stack: [name, has a tip]
const lineOf = i => body.slice(0, i).split("\n").length;  // within body
let total = 0;
for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g)) {
  const [tag, close, raw] = m, name = raw.toLowerCase();
  if (close) { const i = stack.findLastIndex(s => s[0] === name); if (i >= 0) stack.length = i; continue; }
  const own = tipped.test(tag);
  if (CONTROL.has(name)) {
    total++;
    if (!own && !stack.some(s => s[1]) && !skip.some(r => r.test(tag))) {
      const n = lineOf(m.index), id = tag.match(/\sid="([^"]+)"/)?.[1], text = lines[n - 1].slice(lines[n - 1].indexOf(tag) + tag.length).replace(/<[^>]*>/g, "").trim().slice(0, 30);
      misses.push(`  index.html:${first + n}  <${name}${id ? "#" + id : ""}> ${text}`);
    }
  }
  if (!VOID.has(name) && !tag.endsWith("/>")) stack.push([name, own]);
}
console.log(`hover help: ${total - misses.length} of ${total} static controls have a tip`);
if (misses.length) console.log(misses.join("\n"));
process.exit(strict && misses.length ? 1 : 0);
