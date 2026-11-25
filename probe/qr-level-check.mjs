import { encodeMatrix } from "../host/qr_encode.js";
import { decodeMatrix } from "../packages/dsh_arkts/build/index.mjs";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
};

const samples = [
  "hello",
  "a url https://example.com/x?y=1",
  "芝麻开门",
  '{"v":1,"id":"abcdef","key":"AAAA","name":"Pocket Harness Host"}',
  "a".repeat(542),
  "a".repeat(300),
];
for (const level of ["L", "M", "Q", "H"]) {
  for (const text of samples) {
    const { version, cells } = encodeMatrix(text, { level });
    let decoded = null;
    try { decoded = decodeMatrix(cells); } catch (error) { decoded = { text: `threw ${error.message}` }; }
    const got = decoded?.text ?? decoded;
    const ok = got === text;
    check(`level ${level} ${text.length}B v${version} ${cells.length}x${cells.length}`, ok, ok ? "" : String(got).slice(0, 80));
  }
}
console.log(failed === 0 ? "ALL LEVEL CHECKS PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
