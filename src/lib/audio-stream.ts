export const TARGET_SAMPLE_RATE = 16000;

export function downsampleTo16kHz(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return input;
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, input.length - 1);
    const frac = srcIndex - low;
    result[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return result;
}

export function float32ToInt16(floatSamples: Float32Array): Int16Array {
  const int16 = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, floatSamples[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return int16;
}

export function encodeWavBlob(floatSamples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Blob {
  const int16 = float32ToInt16(floatSamples);
  const buffer = new ArrayBuffer(44 + int16.byteLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + int16.byteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, int16.byteLength, true);

  const pcmView = new Int16Array(buffer, 44);
  pcmView.set(int16);

  return new Blob([buffer], { type: 'audio/wav' });
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

const WORKLET_CODE = `
class PcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset >= this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-stream-processor', PcmStreamProcessor);
`;

export interface MicStreamHandle {
  stop: () => Promise<void>;
}

export async function startMicrophonePcmStream(options: {
  onPcmChunk: (samples16k: Float32Array, rms: number) => void;
  onFrequencyData?: (bins: Uint8Array) => void;
}): Promise<MicStreamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.72;
  source.connect(analyser);

  const freqBins = new Uint8Array(analyser.frequencyBinCount);
  let rafId = 0;
  let stopped = false;

  const pumpAnalyser = () => {
    if (stopped) return;
    if (options.onFrequencyData) {
      analyser.getByteFrequencyData(freqBins);
      options.onFrequencyData(freqBins);
    }
    rafId = requestAnimationFrame(pumpAnalyser);
  };
  if (options.onFrequencyData) {
    rafId = requestAnimationFrame(pumpAnalyser);
  }

  let cleanupNode: () => void = () => {};

  if (audioCtx.audioWorklet && typeof Blob !== 'undefined') {
    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_CODE], { type: 'application/javascript' }),
    );
    try {
      await audioCtx.audioWorklet.addModule(blobUrl);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-stream-processor');
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;

      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (stopped) return;
        const downsampled = downsampleTo16kHz(event.data, audioCtx.sampleRate);
        options.onPcmChunk(downsampled, computeRms(downsampled));
      };

      source.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      cleanupNode = () => {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
        silentGain.disconnect();
      };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } else {
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (stopped) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleTo16kHz(input, audioCtx.sampleRate);
      options.onPcmChunk(downsampled, computeRms(downsampled));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    cleanupNode = () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      silentGain.disconnect();
    };
  }

  return {
    stop: async () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      cleanupNode();
      source.disconnect();
      analyser.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      if (audioCtx.state !== 'closed') {
        await audioCtx.close();
      }
    },
  };
}

export function httpToWsUrl(httpUrl: string, path = '/ws/transcribe'): string {
  const cleaned = httpUrl.trim().replace(/\/+$/, '');
  const wsBase = cleaned.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  return `${wsBase}${path.startsWith('/') ? path : `/${path}`}`;
}
