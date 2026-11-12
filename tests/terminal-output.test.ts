import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalWriter } from "../src/terminal-output.ts";

test("terminal lines return to column zero, preserving split CRLF and UTF-8", () => {
  const chunks: Buffer[] = [];
  const write = terminalWriter({ isTTY: true, write: ((b: Buffer) => { chunks.push(b); return true; }) as NodeJS.WriteStream["write"] });
  write("first\nsecond\r"); write("\n");
  const unicode = Buffer.from("tensão\n");
  for (const byte of unicode) write(Buffer.from([byte]));
  assert.equal(Buffer.concat(chunks).toString(), "first\r\nsecond\r\ntensão\r\n");
});

test("redirected output is preserved byte for byte", () => {
  const chunks: Buffer[] = [];
  const write = terminalWriter({ isTTY: false, write: ((b: Buffer) => { chunks.push(b); return true; }) as NodeJS.WriteStream["write"] });
  const input = Buffer.from("first\nsecond\r\n");
  write(input);
  assert.deepEqual(Buffer.concat(chunks), input);
});
