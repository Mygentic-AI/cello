// A separate process pinging a Unix socket on the run's main thread, the way a daemon client would.
// A blocked main thread shows up here as a slow reply.
import { connect } from "node:net";

const socket = connect(process.argv[2] as string);
const rtts: number[] = [];
let sentAt = 0;
let waiting = false;

socket.on("data", () => {
  rtts.push(performance.now() - sentAt);
  waiting = false;
});
socket.on("error", (err) => {
  process.stderr.write(`probe socket error: ${err.message}\n`);
  process.exit(1);
});

// If the run dies, so does the probe.
socket.on("close", () => process.exit(0));

const timer = setInterval(() => {
  if (waiting) return;
  waiting = true;
  sentAt = performance.now();
  socket.write("p");
}, 50);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.stdout.write(`${JSON.stringify({ rtts, stillWaitingMs: waiting ? performance.now() - sentAt : 0 })}\n`, () => process.exit(0));
});
