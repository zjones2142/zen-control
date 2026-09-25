// Packs extension/ into zen-control.xpi (a plain zip) without needing the zip CLI.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = new URL("./extension/", import.meta.url).pathname;
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(root);

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
const u32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);

const local = [], central = []; let offset = 0;
for (const f of files.sort()) {
  const name = Buffer.from(relative(root, f).split("\\").join("/"));
  const data = readFileSync(f), comp = deflateRawSync(data), crc = crc32(data);
  const hdr = Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(data.length), u16(name.length), u16(0), name]);
  local.push(hdr, comp);
  central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(8), u16(0), u16(0x21), u32(crc), u32(comp.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
  offset += hdr.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
const out = new URL("./zen-control.xpi", import.meta.url).pathname;
writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`wrote ${out} (${files.length} files)`);
