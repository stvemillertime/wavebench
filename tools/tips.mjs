// Hover-help coverage: lists the controls in index.html's static markup that have no data-tip (or title, which the
// page moves into data-tip), so nothing reaches the status bar when they're hovered. Warns by default; --strict fails.
//   node tools/tips.mjs [--strict]
// Controls built by script (transform grid, library cards, bank rows...) aren't seen here: give their templates a
// data-tip too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const at = html.indexOf("<body"), body = html.slice(at, html.indexOf("<script", at)), first = html.slice(0, at).split("\n").length - 1;
const strict = process.argv.includes("--strict");

// a tip on the wrapping <label> covers the control inside it
const tipped = /\s(data-tip|title)="[^"]+"/;
const skip = [/\shidden[\s>]/, /type="file"/, /type="hidden"/, /aria-hidden="true"/];
const lines = body.split("\n"), misses = [];
const lineOf = i => body.slice(0, i).split("\n").length;  // within body
for (const m of body.matchAll(/<(button|input|select|textarea|canvas)\b[^>]*>/g)) {
  const tag = m[0];
  if (tipped.test(tag) || skip.some(r => r.test(tag))) continue;
  // inside a <label ... title/data-tip> that's still open at this point
  const before = body.slice(Math.max(0, body.lastIndexOf("<label", m.index)), m.index);
  if (before.startsWith("<label") && !before.includes("</label>") && tipped.test(before.slice(0, before.indexOf(">") + 1))) continue;
  const n = lineOf(m.index), id = tag.match(/\sid="([^"]+)"/)?.[1], text = lines[n - 1].slice(lines[n - 1].indexOf(tag) + tag.length).replace(/<[^>]*>/g, "").trim().slice(0, 30);
  misses.push(`  index.html:${first + n}  <${m[1]}${id ? "#" + id : ""}> ${text}`);
}
const total = [...body.matchAll(/<(button|input|select|textarea|canvas)\b/g)].length;
console.log(`hover help: ${total - misses.length} of ${total} static controls have a tip`);
if (misses.length) console.log(misses.join("\n"));
process.exit(strict && misses.length ? 1 : 0);
