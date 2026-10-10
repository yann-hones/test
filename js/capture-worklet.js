// Transmet le flux du micro au fil principal par paquets, sans perte ni recouvrement,
// pour pouvoir analyser plusieurs secondes de son continu.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1024);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      let i = 0;
      while (i < input.length) {
        const n = Math.min(input.length - i, this.chunk.length - this.fill);
        this.chunk.set(input.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === this.chunk.length) {
          this.port.postMessage(this.chunk, [this.chunk.buffer]);
          this.chunk = new Float32Array(1024);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
