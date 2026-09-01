export interface SignalPayload {
  type: string;
  tagName: string;
  attributes: Record<string, string>;
  body: string;
  /** Stable key for Flue admission when this signal represents one durable event. */
  idempotencyKey?: string;
}

export function createWorkerCompletionSignal(params: {
  id: string;
  status: string;
  name: string;
  body: string;
}): SignalPayload {
  return {
    type: 'worker.completion',
    tagName: 'worker_completion',
    attributes: {
      id: params.id,
      status: params.status,
      name: params.name,
    },
    body: params.body,
    idempotencyKey: `worker-completion:${params.id}`,
  };
}

export function createAutomationTriggerSignal(params: {
  id: string;
  name: string;
  scheduledAt: string;
  instruction: string;
}): SignalPayload {
  return {
    type: 'automation.trigger',
    tagName: 'automation_trigger',
    attributes: {
      id: params.id,
      name: params.name,
      scheduled_at: params.scheduledAt,
    },
    body: params.instruction,
    idempotencyKey: `automation:${params.id}:${params.scheduledAt}`,
  };
}
