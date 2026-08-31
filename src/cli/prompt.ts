import readline from 'node:readline';

export function promptQuestion(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => resolve(answer.trim()));
  });
}

export async function promptSecret(
  rl: readline.Interface,
  query: string,
  maskInput: boolean
): Promise<string> {
  if (!maskInput || !rl.terminal) {
    return await promptQuestion(rl, query);
  }

  const writable = rl as readline.Interface & {
    _writeToOutput?: (value: string) => void;
  };
  const writeToOutput = writable._writeToOutput;
  if (!writeToOutput) {
    return await promptQuestion(rl, query);
  }

  writable._writeToOutput = function writeMasked(value: string): void {
    if (value === query || value === '\n' || value === '\r\n') {
      writeToOutput.call(this, value);
      return;
    }

    // readline sends both typed characters and redraw sequences through this
    // hook. Replacing every printable character keeps values out of the TTY.
    const printableCount = [...value].filter((character) => character >= ' ' && character !== '\u007f').length;
    if (printableCount > 0) {
      writeToOutput.call(this, '*'.repeat(printableCount));
    }
  };

  try {
    return await promptQuestion(rl, query);
  } finally {
    writable._writeToOutput = writeToOutput;
  }
}
