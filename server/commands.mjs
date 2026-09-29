// One execution lane keeps input ordered around asynchronous stream changes.
// Guards run when a command reaches the lane, so disconnected clients cannot
// leave commands waiting to operate on a later controller's session.
export class CommandQueue {
  constructor({ capacity = 64, maxWait = 5000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.maxWait = maxWait;
    this.now = now;
    this.pending = 0;
    this.tail = Promise.resolve();
  }
  run(execute, guard = () => true, { cleanup = false } = {}) {
    if (!cleanup && this.pending >= this.capacity)
      return Promise.reject(
        new Error("The Mac is busy. Wait for the current command."),
      );
    this.pending++;
    const created = this.now();
    const run = async () => {
      if (!guard())
        throw new Error("This control session is no longer active.");
      if (!cleanup && this.now() - created > this.maxWait)
        throw new Error("The command expired before it could run. Try again.");
      return execute();
    };
    const result = this.tail.then(run, run).finally(() => {
      this.pending--;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
