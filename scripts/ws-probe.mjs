import WebSocket from "ws";

async function probe(url, label, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const events = [];
    const start = Date.now();
    ws.on("upgrade", (res) => {
      events.push({ t: Date.now() - start, type: "upgrade-response", statusCode: res.statusCode, headers: res.headers });
    });
    ws.on("unexpected-response", (req, res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString().slice(0, 500);
        events.push({ t: Date.now() - start, type: "unexpected-response", statusCode: res.statusCode, headers: res.headers, body });
        try { ws.close(); } catch {}
      });
    });
    ws.on("open", () => events.push({ t: Date.now() - start, type: "open" }));
    ws.on("message", (data) => events.push({ t: Date.now() - start, type: "message", len: data.length, preview: data.toString().slice(0, 150) }));
    ws.on("close", (code, reason) => {
      events.push({ t: Date.now() - start, type: "close", code, reason: reason.toString() });
      console.log(`=== ${label} ===\n${JSON.stringify(events, null, 2)}\n`);
      resolve();
    });
    ws.on("error", (err) => events.push({ t: Date.now() - start, type: "error", message: err.message }));
    setTimeout(() => { try { ws.terminate(); } catch {} }, 8000);
  });
}

await probe("wss://cthulhu1.tail8dd042.ts.net/ws?sessionId=probe", "default");
await probe("wss://cthulhu1.tail8dd042.ts.net/ws?sessionId=probe", "with-origin", { Origin: "https://cthulhu1.tail8dd042.ts.net" });
