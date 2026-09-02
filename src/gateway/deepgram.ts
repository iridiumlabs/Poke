import fs from 'fs';
import path from 'path';
import { getLogger, redactSecrets } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';
import { providerRequestSignal } from '../providers/fetch.js';
import { resolvePokePaths } from '../config/paths.js';

function providerErrorDetail(detail: string): string {
  const cleaned = String(redactSecrets(detail))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 600 ? `${cleaned.slice(0, 597)}...` : cleaned;
}

export class DeepgramHandler {
  constructor(private apiKey?: string, private customHome?: string) {}

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async synthesizeToAudioFile(text: string): Promise<{ audioPath: string; mimeType: string }> {
    if (!this.apiKey) {
      throw new Error('Deepgram API key is not configured. Add it with `poke configure`.');
    }

    const logger = getLogger(this.customHome);
    logger.info('Synthesizing speech via Deepgram Flux TTS');

    const paths = resolvePokePaths(this.customHome);
    const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
    const outputPath = path.join(paths.outboxDir, filename);

    return await withProviderRetry(async () => {
      const url = new URL('https://api.deepgram.com/v2/speak');
      url.searchParams.set('model', 'flux-alexis-en');
      url.searchParams.set('encoding', 'opus');
      url.searchParams.set('container', 'ogg');

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: providerRequestSignal(),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const message = detail
          ? `Deepgram TTS returned ${res.status}: ${providerErrorDetail(detail)}`
          : `Deepgram TTS returned ${res.status}.`;
        const err = new Error(message);
        (err as any).status = res.status;
        (err as any).headers = res.headers;
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
