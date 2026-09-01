import { confirm, input, password, select } from '@inquirer/prompts';

export interface SelectChoice<T extends string> {
  value: T;
  name: string;
  description?: string;
}

export interface TextPromptOptions {
  message: string;
  default?: string;
  required?: boolean;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}

export interface CliUi {
  select<T extends string>(message: string, choices: readonly SelectChoice<T>[], defaultValue?: T): Promise<T>;
  text(options: TextPromptOptions): Promise<string>;
  secret(options: TextPromptOptions): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  spinner<T>(message: string, action: () => Promise<T>): Promise<T>;
  note(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export class CliCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CliCancelledError';
  }
}

/** A user-facing command failure that has already been rendered by the UI. */
export class CliCommandFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliCommandFailedError';
  }
}

export class InteractiveCliRequiredError extends Error {
  constructor() {
    super('This command needs an interactive terminal. Run it over an SSH TTY.');
    this.name = 'InteractiveCliRequiredError';
  }
}

export function isPromptCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'ExitPromptError' || name === 'CancelPromptError' || name === 'AbortPromptError';
}

export function colorizeCliText(text: string, colorEnabled: boolean): string {
  return colorEnabled ? `\u001b[34m${text}\u001b[0m` : text;
}

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY && !Object.hasOwn(process.env, 'NO_COLOR'));
}

export class InquirerCliUi implements CliUi {
  private readonly useColor = colorEnabled();
  private readonly theme = {
    prefix: {
      idle: colorizeCliText('○', this.useColor),
      done: colorizeCliText('●', this.useColor),
    },
    style: {
      message: (value: string) => colorizeCliText(value, this.useColor),
      answer: (value: string) => colorizeCliText(value, this.useColor),
      highlight: (value: string) => colorizeCliText(value, this.useColor),
      description: (value: string) => (this.useColor ? `\u001b[2m${value}\u001b[0m` : value),
    },
    icon: {
      cursor: colorizeCliText('◉', this.useColor),
    },
  };

  async select<T extends string>(
    message: string,
    choices: readonly SelectChoice<T>[],
    defaultValue?: T
  ): Promise<T> {
    this.assertInteractive();
    return await this.withCancellation(() =>
      select({
        message,
        choices,
        default: defaultValue,
        theme: this.theme,
      } as any)
    );
  }

  async text(options: TextPromptOptions): Promise<string> {
    this.assertInteractive();
    return await this.withCancellation(() =>
      input({
        ...options,
        theme: this.theme,
        validate: this.validation(options),
      } as any)
    );
  }

  async secret(options: TextPromptOptions): Promise<string> {
    this.assertInteractive();
    return await this.withCancellation(() =>
      password({
        message: options.message,
        mask: '*',
        theme: this.theme,
        validate: this.validation(options),
      } as any)
    );
  }

  async confirm(message: string, defaultValue = false): Promise<boolean> {
    this.assertInteractive();
    return await this.withCancellation(() =>
      confirm({
        message,
        default: defaultValue,
        theme: this.theme,
      } as any)
    );
  }

  async spinner<T>(message: string, action: () => Promise<T>): Promise<T> {
    if (!hasInteractiveTerminal()) {
      this.note(message);
      return await action();
    }

    const frames = ['◐', '◓', '◑', '◒'];
    let frame = 0;
    const render = () => {
      process.stdout.write(`\r${colorizeCliText(frames[frame], this.useColor)} ${message}`);
      frame = (frame + 1) % frames.length;
    };
    render();
    const interval = setInterval(render, 100);

    try {
      return await action();
    } finally {
      clearInterval(interval);
      process.stdout.write('\r\u001b[2K');
    }
  }

  note(message: string): void {
    console.log(message);
  }

  success(message: string): void {
    console.log(`${colorizeCliText('✓', this.useColor)} ${message}`);
  }

  warning(message: string): void {
    console.log(`${colorizeCliText('!', this.useColor)} ${message}`);
  }

  error(message: string): void {
    console.error(`${colorizeCliText('✗', this.useColor)} ${message}`);
  }

  private validation(options: TextPromptOptions): (value: string) => boolean | string | Promise<boolean | string> {
    return async (value: string) => {
      const cleaned = value.trim();
      if (options.required && !cleaned) {
        return 'A value is required.';
      }
      return (await options.validate?.(cleaned)) ?? true;
    };
  }

  private assertInteractive(): void {
    if (!hasInteractiveTerminal()) {
      throw new InteractiveCliRequiredError();
    }
  }

  private async withCancellation<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error: unknown) {
      if (isPromptCancellation(error)) {
        throw new CliCancelledError();
      }
      throw error;
    }
  }
}

export function createCliUi(): CliUi {
  return new InquirerCliUi();
}
