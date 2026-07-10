import { createInterface } from 'node:readline/promises';

const ensureInteractiveTty = (): void => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('OAuth setup requires a human-controlled interactive TTY');
  }
};

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  ensureInteractiveTty();
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    readline.close();
  }
}

/** Reads a literal approval phrase without whitespace normalization. */
export async function promptLiteral(question: string): Promise<string> {
  ensureInteractiveTty();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(`${question}: `);
  } finally {
    readline.close();
  }
}

export async function promptConfirm(question: string): Promise<boolean> {
  const answer = (await promptText(`${question} [y/N]`)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export async function promptHidden(question: string): Promise<string> {
  ensureInteractiveTty();
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = input.isRaw;

  output.write(`${question}: `);
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode(Boolean(previousRawMode));
      input.pause();
      output.write('\n');
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const character of text) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('OAuth setup cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          const trimmed = value.trim();
          if (!trimmed) reject(new Error('A non-empty secret is required'));
          else resolve(trimmed);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
          cleanup();
          reject(new Error('Secret input contains an unsupported control character'));
          return;
        }
        if (value.length >= 16_384) {
          cleanup();
          reject(new Error('Secret input is too long'));
          return;
        }
        value += character;
      }
    };

    input.on('data', onData);
  });
}
