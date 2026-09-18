// Writes an in-progress download into the browser's private file system (OPFS), so large
// files land on disk rather than in memory. Sync access handles only exist inside workers,
// and they're the one OPFS write path Chrome, Firefox and Safari all support.
//
// Messages are handled strictly in order: each one waits for the previous to finish.
'use strict';

let access = null;
let queue = Promise.resolve();

async function handle(msg) {
  switch (msg.op) {
    case 'open': {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(msg.dir, { create: true });
      const file = await dir.getFileHandle(msg.name, { create: true });
      access = await file.createSyncAccessHandle();
      access.truncate(0);
      return;
    }
    case 'write': {
      const bytes = new Uint8Array(msg.buffer, 0, msg.length);
      let done = 0;
      while (done < bytes.length) done += access.write(bytes.subarray(done), { at: msg.at + done });
      return;
    }
    case 'close': {
      if (!access) return;
      await access.flush();
      await access.close();
      access = null;
      return;
    }
    default:
      throw new Error(`unknown op ${msg.op}`);
  }
}

self.onmessage = ({ data: msg }) => {
  queue = queue.then(() => handle(msg)).then(
    () => { if (msg.id != null) self.postMessage({ id: msg.id }); },
    (err) => self.postMessage({ id: msg.id, error: { name: err.name, message: err.message } }),
  );
};
