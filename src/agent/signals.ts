function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return character;
    }
  });
}

export function createWorkerCompletionSignal(params: {
  id: string;
  status: string;
  name: string;
  body: string;
}): string {
  return `<worker_completion id="${escapeXml(params.id)}" status="${escapeXml(params.status)}" name="${escapeXml(params.name)}">\n${escapeXml(params.body)}\n</worker_completion>`;
}

export function createAutomationTriggerSignal(params: {
  id: string;
  name: string;
  scheduledAt: string;
  instruction: string;
}): string {
  return `<automation_trigger id="${escapeXml(params.id)}" name="${escapeXml(params.name)}" scheduled_at="${escapeXml(params.scheduledAt)}">\n${escapeXml(params.instruction)}\n</automation_trigger>`;
}
