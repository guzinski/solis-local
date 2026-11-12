// sudo can temporarily put the terminal in raw mode while tcpdump is running.
// Explicit CRLF keeps each displayed line at column zero in that mode too.
// Preserve bytes exactly when output is redirected to a file or another pipe.
export function terminalWriter(stream: Pick<NodeJS.WriteStream, "write" | "isTTY">): (chunk: Buffer | string) => void {
  let previous = -1;
  return (chunk) => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!stream.isTTY) { stream.write(input); return; }
    const output: number[] = [];
    for (const byte of input) {
      if (byte === 10 && previous !== 13) output.push(13);
      output.push(byte);
      previous = byte;
    }
    stream.write(Buffer.from(output));
  };
}
