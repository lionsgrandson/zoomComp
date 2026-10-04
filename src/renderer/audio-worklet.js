class MeetingPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkSamples = 640; // 40 ms at 16 kHz.
    this.output = new Int16Array(this.chunkSamples);
    this.outputIndex = 0;
    this.sumSquares = 0;
    this.sourcePosition = 0;
    this.totalInputSamples = 0;
    this.ratio = sampleRate / this.targetRate;
  }

  pushSample(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.sumSquares += clamped * clamped;
    this.output[this.outputIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

    if (this.outputIndex === this.output.length) {
      const payload = this.output.buffer;
      const rms = Math.sqrt(this.sumSquares / this.chunkSamples);
      this.port.postMessage({ audio: payload, rms }, [payload]);
      this.output = new Int16Array(this.chunkSamples);
      this.outputIndex = 0;
      this.sumSquares = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    const blockStart = this.totalInputSamples;
    const blockEnd = blockStart + channel.length;

    while (this.sourcePosition < blockEnd) {
      const local = this.sourcePosition - blockStart;
      const index = Math.max(0, Math.min(channel.length - 1, Math.round(local)));
      this.pushSample(channel[index]);
      this.sourcePosition += this.ratio;
    }

    this.totalInputSamples = blockEnd;
    return true;
  }
}

registerProcessor('meeting-pcm-processor', MeetingPcmProcessor);
