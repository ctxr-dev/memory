import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Crash-safe file write: write to a sibling temp file, fsync it, then rename onto
// the final path. A POSIX rename within the same directory is atomic, so a reader
// (or a crash) never observes a half-written or truncated file: either the old
// content or the complete new content. Used for the self-healing state the cron
// job must always be able to read back (entity state, issues index, issue reports,
// the front-truncated attempts log).
//
// The temp name carries the pid + a random suffix so two concurrent writers to
// the same path never collide on the temp file. On any failure the temp is
// removed and the original is left untouched.
export function writeFileAtomic(filePath, data, { mode = 0o644 } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  let fd;
  try {
    // wx: fail if the temp somehow exists (the unique name makes that a real bug).
    fd = fs.openSync(tmp, "wx", mode);
    // Loop writeSync until every byte lands: a single writeSync can short-write a
    // large payload, silently truncating the file. Normalise to a Buffer so the
    // offset/length form writes an exact remaining-byte count.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    let off = 0;
    while (off < buf.length) {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // openSync's mode is masked by umask; force the exact bits.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
    // Best-effort fsync of the containing directory so the rename (the directory
    // entry) is itself durable across power loss. Strictly best-effort: the data
    // is already safely renamed into place, and some platforms reject opening a
    // directory for fsync.
    try {
      const dfd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* directory fsync unsupported / not permitted: ignore */ }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}
