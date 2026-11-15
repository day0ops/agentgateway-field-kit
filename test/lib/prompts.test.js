import { test, expect, describe } from 'bun:test';
import { Prompts } from '../../src/lib/prompts.js';

// `_rawMultiSelect` only checks that stdin/stdout look TTY-like, so a non-TTY
// test process can drive its real keypress handler by faking those bits and
// emitting synthetic 'keypress' events.
function buildChoices(count) {
  const choices = [];
  for (let i = 0; i < count; i++) {
    choices.push({ name: `item-${i}`, value: `v${i}` });
  }
  return choices;
}

function typeString(str) {
  for (const ch of str) {
    process.stdin.emit('keypress', ch, { name: ch, sequence: ch });
  }
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Runs `_rawMultiSelect` with stdin/stdout faked as a TTY, capturing every
 * `stdout.write` chunk. Restores the real stdin/stdout methods afterwards
 * even if the body throws, so no state leaks into other tests.
 * @param {Array} choices
 * @param {Function} drive - called once the prompt has rendered; emits keypresses
 * @returns {Promise<{result: *, chunks: string[]}>}
 */
async function runMultiSelect(choices, drive) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const original = {
    isTTY: stdin.isTTY,
    setRawMode: stdin.setRawMode,
    resume: stdin.resume,
    pause: stdin.pause,
    rows: stdout.rows,
    write: stdout.write,
  };

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdout.rows = 40;

  const chunks = [];
  stdout.write = chunk => {
    chunks.push(chunk.toString());
    return true;
  };

  try {
    const promise = Prompts._rawMultiSelect('Pick stuff', choices);
    setImmediate(() => drive());
    const result = await promise;
    return { result, chunks };
  } finally {
    stdin.isTTY = original.isTTY;
    stdin.setRawMode = original.setRawMode;
    stdin.resume = original.resume;
    stdin.pause = original.pause;
    stdout.rows = original.rows;
    stdout.write = original.write;
    // Belt-and-braces: guarantee no stray keypress listener survives into
    // the next test, regardless of whether _rawMultiSelect's own cleanup ran.
    stdin.removeAllListeners('keypress');
  }
}

/**
 * Runs `_rawSelect` with stdin/stdout faked as a TTY, capturing every
 * `stdout.write` chunk. Mirrors `runMultiSelect` above.
 * @param {Array} choices
 * @param {Function} drive - called once the prompt has rendered; emits keypresses
 * @param {object} [opts]
 * @param {number} [opts.columns] - fakes a narrow/wide terminal width
 * @returns {Promise<{result: *, chunks: string[]}>}
 */
async function runSelect(choices, drive, { columns } = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const original = {
    isTTY: stdin.isTTY,
    setRawMode: stdin.setRawMode,
    resume: stdin.resume,
    pause: stdin.pause,
    rows: stdout.rows,
    columns: stdout.columns,
    write: stdout.write,
  };

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdout.rows = 40;
  if (columns !== undefined) stdout.columns = columns;

  const chunks = [];
  stdout.write = chunk => {
    chunks.push(chunk.toString());
    return true;
  };

  try {
    const promise = Prompts._rawSelect('Pick one', choices);
    setImmediate(() => drive());
    const result = await promise;
    return { result, chunks };
  } finally {
    stdin.isTTY = original.isTTY;
    stdin.setRawMode = original.setRawMode;
    stdin.resume = original.resume;
    stdin.pause = original.pause;
    stdout.rows = original.rows;
    stdout.columns = original.columns;
    stdout.write = original.write;
    stdin.removeAllListeners('keypress');
  }
}

/**
 * The last rendered frame before `finish()` wrote its "✔ ..." confirmation
 * line - i.e. the picker's on-screen state right before the keypress that
 * ended it, regardless of how many re-renders navigation triggered.
 * @param {string[]} chunks
 * @returns {string}
 */
function lastRenderedFrame(chunks) {
  const plain = chunks.map(stripAnsi);
  // The real finish line always starts with the checkmark (chalk codes are
  // already stripped) - matching only at the start avoids mistaking a choice
  // whose own name/detail happens to contain '✔' for the finish line.
  const finishIdx = plain.findIndex(c => c.startsWith('✔'));
  const cutoff = finishIdx === -1 ? plain.length : finishIdx;
  for (let i = cutoff - 1; i >= 0; i--) {
    if (plain[i].trim()) return plain[i];
  }
  return '';
}

describe('_rawSelect focused-only detail rendering', () => {
  test('the focused choice renders its detail lines, indented', async () => {
    const choices = [
      { name: 'short', value: 'v0', detail: 'one\ntwo\nthree' },
      { name: 'other', value: 'v1' },
    ];

    const { result, chunks } = await runSelect(choices, () => {
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result.value).toBe('v0');
    const lastFrame = lastRenderedFrame(chunks);
    // The first choice is focused by default (defaultIndex: 0) - its detail shows.
    expect(lastFrame).toContain('    one');
    expect(lastFrame).toContain('    two');
    expect(lastFrame).toContain('    three');
  });

  test("moving focus hides the previous choice's detail and shows the new one's", async () => {
    const choices = [
      { name: 'first', value: 'v0', detail: 'detail-of-first' },
      { name: 'second', value: 'v1', detail: 'detail-of-second' },
    ];

    const { result, chunks } = await runSelect(choices, () => {
      process.stdin.emit('keypress', undefined, { name: 'down' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result.value).toBe('v1');
    const lastFrame = lastRenderedFrame(chunks);
    expect(lastFrame).toContain('detail-of-second');
    expect(lastFrame).not.toContain('detail-of-first');
  });

  test('a detail line longer than the terminal width wraps into multiple rows', async () => {
    const longLine =
      'this is a single logical detail line that is much longer than a narrow forty column terminal can fit on one row';
    const choices = [{ name: 'item', value: 'v0', detail: longLine }];

    const { result, chunks } = await runSelect(
      choices,
      () => {
        process.stdin.emit('keypress', undefined, { name: 'return' });
      },
      { columns: 40 }
    );

    expect(result.value).toBe('v0');
    const lastFrame = lastRenderedFrame(chunks);
    const renderedLines = lastFrame.split('\n');
    // Every rendered line (header, choice, each wrapped detail row) must fit
    // the fake terminal width - otherwise the cursor-up redraw math on the
    // next render would move up fewer screen rows than this frame actually
    // occupies.
    for (const line of renderedLines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // The original text survives, just split across more than one row.
    expect(renderedLines.filter(l => l.trim().startsWith('this')).length).toBe(1);
    expect(renderedLines.length).toBeGreaterThan(2);
  });

  test('a choice with no detail renders no extra lines when focused', async () => {
    const choices = [{ name: 'plain', value: 'v0' }];

    const { result, chunks } = await runSelect(choices, () => {
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result.value).toBe('v0');
    const lastFrame = lastRenderedFrame(chunks);
    expect(lastFrame).toBe('? Pick one  (enter/space to select)\n❯ plain\n');
  });
});

describe('_rawMultiSelect keypress filter-leak fix', () => {
  test('space does not leak into the filter when the current filter matches nothing', async () => {
    const choices = buildChoices(35);

    const { result, chunks } = await runMultiSelect(choices, () => {
      typeString('zzz');
      process.stdin.emit('keypress', undefined, { name: 'space' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result).toEqual([]);

    const filterLines = chunks.filter(c => /Filter: zzz/.test(c));
    expect(filterLines.length).toBeGreaterThan(0);
    for (const chunk of filterLines) {
      expect(chunk).not.toMatch(/Filter: zzz /);
    }
  });

  test('backspace does not leak into the filter when the query is already empty', async () => {
    const choices = buildChoices(35);

    const { result, chunks } = await runMultiSelect(choices, () => {
      process.stdin.emit('keypress', '\b', { name: 'backspace' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result).toEqual([]);

    for (const chunk of chunks) {
      const plain = stripAnsi(chunk);
      const filterLine = plain.split('\n').find(line => line.includes('Filter:'));
      if (filterLine) {
        expect(filterLine).not.toContain('\b');
      }
    }
  });
});
