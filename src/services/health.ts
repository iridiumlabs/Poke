import { Composio } from '@composio/core';
import { Exa } from 'exa-js';

export type ServiceCredentialKey =
  | 'composioApiKey'
  | 'supermemoryApiKey'
  | 'exaApiKey'
  | 'deepgramApiKey'
  | 'groqApiKey';

export interface RequiredService {
  readonly name: string;
  readonly key: ServiceCredentialKey;
}

export const REQUIRED_SERVICES = [
  { name: 'Composio', key: 'composioApiKey' },
  { name: 'Supermemory', key: 'supermemoryApiKey' },
  { name: 'Exa', key: 'exaApiKey' },
  { name: 'Deepgram', key: 'deepgramApiKey' },
  { name: 'Groq', key: 'groqApiKey' },
] as const satisfies readonly RequiredService[];

const VALIDATION_TIMEOUT_MS = 10_000;

function withinValidationTimeout<T>(service: string, action: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${service} validation timed out.`));
    }, VALIDATION_TIMEOUT_MS);

    void action.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

/** Runs one bounded, read-only request for a configured service credential. */
export async function validateServiceCredential(
  service: ServiceCredentialKey,
  apiKey: string
): Promise<void> {
  if (!apiKey.trim()) {
    throw new Error('API key is required.');
  }

  switch (service) {
    case 'composioApiKey': {
      const composio = new Composio({ apiKey });
      await withinValidationTimeout(
        'Composio',
        composio.tools.getRawComposioTools({ search: 'health' })
      );
      return;
    }
    case 'supermemoryApiKey': {
      const response = await fetch('https://api.supermemory.ai/v4/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: 'health check', containerTag: 'poke-owner', limit: 1 }),
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Supermemory returned ${response.status}.`);
      return;
    }
    case 'exaApiKey': {
      const exa = new Exa(apiKey);
      await withinValidationTimeout('Exa', exa.search('health check', { numResults: 1 }));
      return;
    }
    case 'deepgramApiKey': {
      const response = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${apiKey}` },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Deepgram returned ${response.status}.`);
      return;
    }
    case 'groqApiKey': {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Groq returned ${response.status}.`);
      return;
    }
  }
}
