import { ModelInfo, ReasoningEffort } from '../config/types.js';
import { withProviderRetry } from './retry.js';
import { providerRequestSignal } from './fetch.js';

const VALID_REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Checks whether a Fireworks model entry represents a serverless text/chat/vision
 * model capable of functioning as a Poke agent model.
 * Excludes embeddings, rerankers, image/audio generation, guardrails, and non-serverless models.
 */
export function isCompatibleFireworksModel(item: unknown): boolean {
  if (item === null || (typeof item !== 'object' && typeof item !== 'string')) {
    return false;
  }

  const isObject = typeof item === 'object' && item !== null;
  const obj = isObject ? (item as Record<string, unknown>) : {};
  const id = typeof item === 'string' ? item : typeof obj.id === 'string' ? obj.id : typeof obj.name === 'string' ? obj.name : undefined;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return false;
  }

  const lowerId = id.toLowerCase();

  // 1. Check deployment & serverless availability flags
  if (obj.serverless === false || obj.is_serverless === false || obj.supports_serverless === false) {
    return false;
  }
  if (obj.isServerless === false || obj.supportsServerless === false || obj.deployed === false) {
    return false;
  }
  if (typeof obj.state === 'string' && ['INACTIVE', 'DISABLED', 'DELETED', 'ARCHIVED'].includes(obj.state.toUpperCase())) {
    return false;
  }
  if (typeof obj.status === 'string' && ['INACTIVE', 'DISABLED', 'DELETED', 'ARCHIVED'].includes(obj.status.toUpperCase())) {
    return false;
  }
  if (obj.status && typeof obj.status === 'object') {
    const statusCode = (obj.status as { code?: string }).code;
    if (typeof statusCode === 'string' && ['INACTIVE', 'DISABLED', 'DELETED'].includes(statusCode.toUpperCase())) {
      return false;
    }
  }

  // 2. Check explicit tool calling support flag
  if (obj.supports_tools === false || obj.supportsTools === false) {
    return false;
  }

  // 3. Extract categorical metadata fields from object or baseModelDetails
  const baseDetails = (obj.baseModelDetails || obj.base_model_details) as Record<string, unknown> | undefined;
  const kind = String(obj.kind || '').toLowerCase();
  const type = String(obj.type || obj.model_type || obj.modelType || baseDetails?.modelType || baseDetails?.model_type || '').toLowerCase();
  const task = String(obj.task || '').toLowerCase();
  const architecture = String(obj.architecture || '').toLowerCase();

  const combinedMeta = `${kind} ${type} ${task} ${architecture}`;

  // 4. Exclude Embeddings
  if (
    combinedMeta.includes('embedding') ||
    combinedMeta.includes('embed') ||
    lowerId.includes('embedding') ||
    lowerId.includes('embed') ||
    lowerId.includes('bge-') ||
    lowerId.includes('nomic-embed')
  ) {
    return false;
  }

  // 5. Exclude Rerankers
  if (
    combinedMeta.includes('rerank') ||
    lowerId.includes('rerank') ||
    lowerId.includes('bge-reranker')
  ) {
    return false;
  }

  // 6. Exclude Image & Video Generation / Diffusers / Inpainting
  if (
    combinedMeta.includes('image_generation') ||
    combinedMeta.includes('image-generation') ||
    combinedMeta.includes('text-to-image') ||
    combinedMeta.includes('image-to-image') ||
    combinedMeta.includes('diffusion') ||
    combinedMeta.includes('diffuser') ||
    combinedMeta.includes('video') ||
    lowerId.includes('flux') ||
    lowerId.includes('stable-diffusion') ||
    lowerId.includes('sdxl') ||
    lowerId.includes('sd-') ||
    lowerId.includes('playground-') ||
    lowerId.includes('kandinsky') ||
    lowerId.includes('deepfloyd') ||
    lowerId.includes('controlnet') ||
    lowerId.includes('svd') ||
    lowerId.includes('cogvideo') ||
    lowerId.includes('wan2') ||
    lowerId.includes('hunyuan-video') ||
    lowerId.includes('text2img') ||
    lowerId.includes('txt2img') ||
    lowerId.includes('img2img') ||
    lowerId.includes('inpainting') ||
    lowerId.includes('upscaler')
  ) {
    return false;
  }

  // 7. Exclude Audio / Speech / Transcription (Whisper, TTS, STT)
  if (
    combinedMeta.includes('audio') ||
    combinedMeta.includes('speech') ||
    combinedMeta.includes('transcription') ||
    combinedMeta.includes('tts') ||
    combinedMeta.includes('stt') ||
    combinedMeta.includes('whisper') ||
    lowerId.includes('whisper') ||
    lowerId.includes('bark') ||
    lowerId.includes('seamless') ||
    lowerId.includes('mms-tts') ||
    lowerId.includes('tts') ||
    lowerId.includes('stt') ||
    lowerId.includes('speech') ||
    lowerId.includes('voice') ||
    lowerId.includes('musicgen')
  ) {
    return false;
  }

  // 8. Exclude Guardrails / Moderation / Reward models
  if (
    combinedMeta.includes('guard') ||
    combinedMeta.includes('moderation') ||
    combinedMeta.includes('reward') ||
    combinedMeta.includes('classifier') ||
    lowerId.includes('guard') ||
    lowerId.includes('moderation') ||
    lowerId.includes('reward') ||
    lowerId.includes('classifier') ||
    lowerId.includes('rm-') ||
    lowerId.includes('critic')
  ) {
    return false;
  }

  return true;
}

/**
 * Extracts normalized ModelInfo from a Fireworks live model item with authoritative
 * capabilities and conservative defaults.
 */
export function extractFireworksModelInfo(item: unknown): ModelInfo | null {
  if (!isCompatibleFireworksModel(item)) {
    return null;
  }

  const isObject = typeof item === 'object' && item !== null;
  const obj = isObject ? (item as Record<string, unknown>) : {};
  const id = typeof item === 'string' ? item : typeof obj.id === 'string' ? obj.id : typeof obj.name === 'string' ? obj.name : '';
  if (!id) return null;

  const lowerId = id.toLowerCase();
  const name =
    typeof obj.displayName === 'string' && obj.displayName
      ? obj.displayName
      : typeof obj.display_name === 'string' && obj.display_name
        ? obj.display_name
        : typeof obj.name === 'string' && obj.name
          ? obj.name
          : id;

  const description = typeof obj.description === 'string' && obj.description ? obj.description : undefined;

  // Context window: authoritative metadata with 128000 conservative default
  let contextWindow = 128000;
  const rawContext =
    obj.context_length ??
    obj.contextLength ??
    obj.context_window ??
    obj.contextWindow ??
    obj.max_context_length ??
    obj.maxContextLength;

  if (typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0) {
    contextWindow = Math.max(1, rawContext);
  } else if (typeof rawContext === 'string') {
    const parsed = Number(rawContext.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      contextWindow = Math.max(1, parsed);
    }
  }

  // Input modalities / acceptsImages
  let acceptsImages = false;
  if (typeof obj.supports_image_input === 'boolean') {
    acceptsImages = obj.supports_image_input;
  } else if (typeof obj.supportsImageInput === 'boolean') {
    acceptsImages = obj.supportsImageInput;
  } else {
    const modalities = (obj.input_modalities || obj.inputModalities || obj.modalities || obj.input) as unknown;
    if (Array.isArray(modalities)) {
      acceptsImages = modalities.some(
        (m) => typeof m === 'string' && (m.toLowerCase() === 'image' || m.toLowerCase() === 'vision')
      );
    } else {
      // Conservative heuristic from ID when metadata is absent
      acceptsImages =
        lowerId.includes('vision') ||
        lowerId.includes('vl') ||
        lowerId.includes('multimodal') ||
        lowerId.includes('omni') ||
        lowerId.includes('4o');
    }
  }

  // Reasoning support & efforts
  const reasoningEfforts: ReasoningEffort[] = [];
  const rawEfforts = (obj.reasoning_efforts ||
    obj.reasoningEfforts ||
    obj.supported_thinking_levels ||
    obj.supportedThinkingLevels) as unknown;

  if (Array.isArray(rawEfforts) && rawEfforts.length > 0) {
    for (const effort of rawEfforts) {
      if (typeof effort === 'string') {
        const normalized = effort.trim().toLowerCase() as ReasoningEffort;
        if (VALID_REASONING_EFFORTS.has(normalized) && !reasoningEfforts.includes(normalized)) {
          reasoningEfforts.push(normalized);
        }
      }
    }
  } else if (obj.supports_reasoning === true || obj.supportsReasoning === true || obj.reasoning === true) {
    // If flagged as reasoning-capable without specific efforts list, provide standard efforts
    reasoningEfforts.push('low', 'medium', 'high');
  }

  return {
    id,
    name,
    description,
    capabilities: {
      reasoningEfforts,
      acceptsImages,
      contextWindow,
    },
  };
}

export class FireworksCatalog {
  static async fetchLiveModels(apiKey: string): Promise<ModelInfo[]> {
    const url = 'https://api.fireworks.ai/inference/v1/models';

    const rawData: any = await withProviderRetry(async () => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: providerRequestSignal(),
      });

      if (!res.ok) {
        const error = new Error(`Fireworks returned ${res.status}.`);
        (error as any).status = res.status;
        (error as any).headers = res.headers;
        throw error;
      }

      return await res.json();
    });

    const modelsList: any[] = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.data)
        ? rawData.data
        : Array.isArray(rawData?.models)
          ? rawData.models
          : [];

    const result: ModelInfo[] = [];

    for (const item of modelsList) {
      const modelInfo = extractFireworksModelInfo(item);
      if (modelInfo) {
        result.push(modelInfo);
      }
    }

    return result;
  }
}
