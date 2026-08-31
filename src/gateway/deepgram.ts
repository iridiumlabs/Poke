import fs from 'fs';
import path from 'path';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';
import { resolvePokePaths } from '../config/paths.js';

export class DeepgramHandler {
  constructor(private apiKey?: string, private customHome?: string) {}

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async transcribe(audioBuffer: Buffer | string, mimeType?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Deepgram API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info('Transcribing audio via Deepgram Nova-3');

    let buffer: Buffer;
    if (typeof audioBuffer === 'string') {
      buffer = fs.readFileSync(audioBuffer);
    } else {
      buffer = audioBuffer;
    }

    return await withProviderRetry(async () => {
      // Use direct REST call to Deepgram Nova-3
      const url = new URL('https://api.deepgram.com/v1/listen');
      url.searchParams.set('model', 'nova-3');
      url.searchParams.set('smart_format', 'true');
      url.searchParams.set('punctuate', 'true');

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': mimeType || 'audio/ogg',
        },
        body: buffer as any,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Deepgram STT returned ${res.status}: ${text}`);
        (err as any).status = res.status;
        throw err;
      }

      const data = (await res.json()) as any;
      const transcript =
        data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

      return transcript.trim();
    });
  }

  async synthesizeToAudioFile(text: string): Promise<{ audioPath: string; mimeType: string }> {
    if (!this.apiKey) {
      throw new Error('Deepgram API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info('Synthesizing speech via Deepgram Flux TTS');

    const paths = resolvePokePaths(this.customHome);
    const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
    const outputPath = path.join(paths.outboxDir, filename);

    return await withProviderRetry(async () => {
      // Use Deepgram Flux through the current /v2/speak API per spec
      const url = new URL('https://api.deepgram.com/v2/speak');
      url.searchParams.set('model', 'aura-2-thalia-en');
      url.searchParams.set('encoding', 'opus');
      url.searchParams.set('container', 'ogg');

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`Deepgram TTS returned ${res.status}: ${errText}`);
        (err as any).status = res.status;
        throw err;
      }

      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));

      return {
        audioPath: outputPath,
        mimeType: 'audio/ogg; codecs=opus',
      };
    });
  }
}
