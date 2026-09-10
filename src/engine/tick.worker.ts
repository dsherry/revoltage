// Backup clock for the frame loop. Chrome stops animation frames for windows it thinks nobody can
// see and slows their timers to about 1 Hz; timers in a worker keep running at full rate.
const scope = self as unknown as { postMessage(msg: number): void };
setInterval(() => scope.postMessage(0), 1000 / 60);
