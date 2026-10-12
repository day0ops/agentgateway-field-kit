import inquirer from 'inquirer';
import chalk from 'chalk';
import readline from 'readline';

/**
 * Count all leaf nodes in a tree node (recursive).
 * @param {Object} node - Directory node with children array
 * @returns {number}
 */
function _countLeaves(node) {
  if (!node.children) return 1;
  return node.children.reduce((sum, child) => sum + _countLeaves(child), 0);
}

export const WINDOW_THRESHOLD = 30;
export const MAX_VIEWPORT_SIZE = 25;

/**
 * How many list rows fit on screen at once, leaving room for header/footer chrome.
 * Capped at MAX_VIEWPORT_SIZE even on a tall terminal, so a long list always
 * reads as a scrollable window rather than a wall of text.
 * @param {number} itemCount - total number of lines that could be shown
 * @param {number} terminalRows - process.stdout.rows (may be undefined/0 off-TTY)
 * @param {number} overhead - lines reserved for header/footer/scroll indicators
 * @returns {number}
 */
export function computeViewportSize(itemCount, terminalRows, overhead) {
  const available = Math.max(10, (terminalRows || 24) - overhead);
  return Math.min(itemCount, available, MAX_VIEWPORT_SIZE);
}

/**
 * Edge-scrolled window offset: only moves when the pointer would otherwise
 * leave the visible window, rather than recentering on every keystroke.
 * @param {number} scrollTop - current window start
 * @param {number} pointerIndex - index the pointer is now at
 * @param {number} totalLines - total number of lines in the full list
 * @param {number} viewportSize - number of lines visible at once
 * @returns {number}
 */
export function computeScrollTop(scrollTop, pointerIndex, totalLines, viewportSize) {
  if (totalLines <= viewportSize) return 0;
  let next = scrollTop;
  if (pointerIndex < next) {
    next = pointerIndex;
  } else if (pointerIndex > next + viewportSize - 1) {
    next = pointerIndex - viewportSize + 1;
  }
  return Math.max(0, Math.min(next, totalLines - viewportSize));
}

/**
 * Indices into `selectable` whose name matches `query` (case-insensitive substring).
 * @param {Array<{name: string}>} selectable
 * @param {string} query
 * @returns {number[]}
 */
export function filterChoiceIndices(selectable, query) {
  if (!query) return selectable.map((_, i) => i);
  const q = query.toLowerCase();
  const indices = [];
  selectable.forEach((choice, i) => {
    if (String(choice.name).toLowerCase().includes(q)) indices.push(i);
  });
  return indices;
}

/**
 * Base prompt utilities for interactive CLI
 * Provides generic prompt methods that can be used throughout the application
 */
export class Prompts {
  /**
   * Raw-mode list selector.
   * ↑/↓ to navigate, Enter to select, Esc/Backspace to go back (when allowBack is true).
   * @param {string} message - The prompt message
   * @param {Array} choices - List of choices (may include inquirer.Separator instances)
   * @param {object} opts
   * @param {boolean} opts.allowBack - Enable Esc/Backspace to trigger a "back" action
   * @param {number} opts.defaultIndex - Initial pointer position (index into selectable items)
   * @returns {Promise<{value: *, back: boolean}>}
   */
  static _rawSelect(message, choices, { allowBack = false, defaultIndex = 0 } = {}) {
    return new Promise(resolve => {
      const stdout = process.stdout;
      const stdin = process.stdin;

      if (!stdin.isTTY) {
        const first = choices.find(
          c => !(c instanceof inquirer.Separator) && c.type !== 'separator'
        );
        resolve({ value: first?.value ?? null, back: false });
        return;
      }

      const selectable = [];
      choices.forEach(c => {
        if (!(c instanceof inquirer.Separator) && c.type !== 'separator') {
          selectable.push(c);
        }
      });

      // Maps a selectable-array index to its position within `choices`, so the
      // window can be computed over the full list (keeping separators attached
      // to their group) while the pointer still only ever indexes `selectable`.
      const choiceIndexOf = [];
      {
        let si = 0;
        choices.forEach((c, i) => {
          if (!(c instanceof inquirer.Separator) && c.type !== 'separator') {
            choiceIndexOf[si] = i;
            si++;
          }
        });
      }

      let pointer = Math.min(defaultIndex, selectable.length - 1);
      let linesRendered = 0;
      let scrollTop = 0;
      const windowed = selectable.length > WINDOW_THRESHOLD;

      const render = () => {
        if (linesRendered > 0) {
          stdout.write(`\x1B[${linesRendered}A\x1B[0J`);
        }

        const lines = [];
        lines.push(
          chalk.green('?') +
            ' ' +
            chalk.bold(message) +
            chalk.yellow('  (enter/space to select' + (allowBack ? ', esc to go back' : '') + ')')
        );

        let viewStart = 0;
        let viewEnd = choices.length;
        if (windowed) {
          const viewportSize = computeViewportSize(choices.length, stdout.rows, 4);
          scrollTop = computeScrollTop(
            scrollTop,
            choiceIndexOf[pointer],
            choices.length,
            viewportSize
          );
          viewStart = scrollTop;
          viewEnd = Math.min(choices.length, scrollTop + viewportSize);
          if (viewStart > 0) lines.push(chalk.dim(`  ↑ ${viewStart} more above`));
        }

        let itemIdx = 0;
        for (let i = 0; i < choices.length; i++) {
          const choice = choices[i];
          const isSeparator = choice instanceof inquirer.Separator || choice.type === 'separator';
          if (i < viewStart || i >= viewEnd) {
            if (!isSeparator) itemIdx++;
            continue;
          }
          if (isSeparator) {
            lines.push(chalk.dim(' ────────────────'));
          } else {
            const active = itemIdx === pointer;
            const prefix = active ? chalk.cyan('❯') : ' ';
            const labelLines = String(choice.name).split('\n');
            const [firstLine, ...restLines] = labelLines;
            const firstLabel = active ? chalk.cyan(firstLine) : firstLine;
            lines.push(`${prefix} ${firstLabel}`);
            for (const line of restLines) {
              lines.push(active ? chalk.cyan(line) : line);
            }
            itemIdx++;
          }
        }

        if (windowed && viewEnd < choices.length) {
          lines.push(chalk.dim(`  ↓ ${choices.length - viewEnd} more below`));
        }

        stdout.write(lines.join('\n') + '\n');
        linesRendered = lines.length;
      };

      const finish = (value, back) => {
        if (linesRendered > 0) {
          stdout.write(`\x1B[${linesRendered}A\x1B[0J`);
        }
        if (!back) {
          const item = selectable[pointer];
          stdout.write(
            chalk.green('✔') +
              ' ' +
              chalk.bold(message) +
              ' ' +
              chalk.cyan(item?.short || item?.name || '') +
              '\n'
          );
        }
        stdout.write('\x1B[?25h');
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
        resolve({ value, back });
      };

      const onKeypress = (_ch, key) => {
        if (!key) return;

        if (key.name === 'up') {
          pointer = (pointer - 1 + selectable.length) % selectable.length;
          render();
        } else if (key.name === 'down') {
          pointer = (pointer + 1) % selectable.length;
          render();
        } else if (key.name === 'return' || key.name === 'space') {
          finish(selectable[pointer].value, false);
        } else if (allowBack && (key.name === 'escape' || key.name === 'backspace')) {
          finish(null, true);
        } else if (key.name === 'c' && key.ctrl) {
          stdout.write('\x1B[?25h');
          stdin.removeListener('keypress', onKeypress);
          stdin.setRawMode(false);
          stdin.pause();
          process.exit(0);
        }
      };

      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdout.write('\x1B[?25l');
      stdin.on('keypress', onKeypress);
      render();
    });
  }

  /**
   * Prompt user to select from a list of options
   * @param {string} message - The prompt message
   * @param {Array<{name: string, value: string, description?: string}>} choices - List of choices
   * @param {string} defaultValue - Default selection
   * @returns {Promise<string>} Selected value
   */
  static async select(message, choices, defaultValue = null) {
    const selectable = choices.filter(
      c => !(c instanceof inquirer.Separator) && c.type !== 'separator'
    );
    let defaultIndex = 0;
    if (defaultValue != null) {
      const idx = selectable.findIndex(c => c.value === defaultValue);
      if (idx >= 0) defaultIndex = idx;
    }
    const { value } = await this._rawSelect(message, choices, { defaultIndex });
    return value;
  }

  /**
   * Multi-level tree selector: navigate directory nodes, select leaf nodes.
   * Tree nodes are either directories ({ label, children[] }) or leaves ({ name, value }).
   * Selecting a directory drills into it. Esc/Backspace goes up one level.
   * @param {string} message - Prompt shown at root level
   * @param {Array} tree - Array of tree nodes (directories or leaves)
   * @returns {Promise<string>} The selected leaf value
   */
  static async selectTree(message, tree) {
    const BACK = Symbol('back');
    const stack = []; // { nodes, message }
    let currentNodes = tree;
    let currentMessage = message;

    while (true) {
      const isRoot = stack.length === 0;
      const dirKeys = new Map();
      const choices = [];

      for (let i = 0; i < currentNodes.length; i++) {
        const node = currentNodes[i];
        if (node.children) {
          const key = `__dir_${i}__`;
          dirKeys.set(key, node);
          const count = _countLeaves(node);
          choices.push({
            name: `${node.label.replace(/-/g, ' ')}${chalk.dim(` (${count})`)}`,
            value: key,
            short: node.label.replace(/-/g, ' '),
          });
        } else {
          choices.push({
            name: node.name,
            value: node.value,
            short: node.value,
          });
        }
      }

      if (!isRoot) {
        choices.push(new inquirer.Separator());
        choices.push({ name: chalk.dim('← Back'), value: BACK });
      }

      const { value: selected, back } = await this._rawSelect(currentMessage, choices, {
        allowBack: !isRoot,
      });

      if (back || selected === BACK) {
        const parent = stack.pop();
        currentNodes = parent.nodes;
        currentMessage = parent.message;
        continue;
      }

      if (dirKeys.has(selected)) {
        const node = dirKeys.get(selected);
        stack.push({ nodes: currentNodes, message: currentMessage });
        currentNodes = node.children;
        currentMessage = `Select from ${chalk.cyan(node.label.replace(/-/g, ' '))}:`;
        continue;
      }

      return selected;
    }
  }

  /**
   * Confirm an action with the user
   * @param {string} message - The confirmation message
   * @param {boolean} defaultValue - Default answer (true/false)
   * @returns {Promise<boolean>} User's confirmation
   */
  static async confirm(message, defaultValue = false) {
    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message,
        default: defaultValue,
      },
    ]);

    return answer.confirmed;
  }

  /**
   * Prompt for text input
   * @param {string} message - The prompt message
   * @param {string} defaultValue - Default value
   * @param {Function} validate - Validation function
   * @returns {Promise<string>} User's input
   */
  static async input(message, defaultValue = '', validate = null) {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message,
        default: defaultValue,
        validate: validate || (() => true),
      },
    ]);

    return answer.value;
  }

  /**
   * Raw-mode multi-select with numbered [✔]/[ ] checkboxes.
   * Space/Enter to toggle, Enter on last confirm confirms all, Ctrl+D to finish.
   * @param {string} message
   * @param {Array<{name: string, value: *, checked?: boolean}>} choices
   * @returns {Promise<Array<*>>} Selected values
   */
  static _rawMultiSelect(message, choices) {
    return new Promise(resolve => {
      const stdout = process.stdout;
      const stdin = process.stdin;

      if (!stdin.isTTY) {
        const defaults = choices
          .filter(c => !(c instanceof inquirer.Separator) && c.type !== 'separator' && c.checked)
          .map(c => c.value);
        resolve(defaults);
        return;
      }

      const selectable = [];
      choices.forEach(c => {
        if (!(c instanceof inquirer.Separator) && c.type !== 'separator') {
          selectable.push(c);
        }
      });

      const checked = new Set(selectable.map((_, i) => i).filter(i => selectable[i].checked));
      const filterable = selectable.length > WINDOW_THRESHOLD;

      // Maps a selectable-array index to its position within `choices` (see
      // _rawSelect for why: keeps separators attached to their group while
      // windowing over the grouped, unfiltered view).
      const choiceIndexOf = [];
      {
        let si = 0;
        choices.forEach((c, i) => {
          if (!(c instanceof inquirer.Separator) && c.type !== 'separator') {
            choiceIndexOf[si] = i;
            si++;
          }
        });
      }

      let filterQuery = '';
      // Indices into `selectable` that match the current filter. `pointer`
      // always indexes into `visible`, never directly into `selectable`, so
      // checked state (keyed by selectable index) survives filtering.
      let visible = selectable.map((_, i) => i);
      let pointer = 0;
      let scrollTop = 0;
      let linesRendered = 0;

      const applyFilter = () => {
        visible = filterChoiceIndices(selectable, filterQuery);
        pointer = Math.min(pointer, Math.max(0, visible.length - 1));
        scrollTop = 0;
      };

      const render = () => {
        if (linesRendered > 0) {
          stdout.write(`\x1B[${linesRendered}A\x1B[0J`);
        }

        const lines = [];
        const hint = filterable
          ? 'space to toggle, type to filter, enter to confirm'
          : 'space to toggle, enter to confirm';
        lines.push(chalk.green('?') + ' ' + chalk.bold(message) + chalk.yellow(`  (${hint})`));
        if (filterQuery) {
          lines.push(chalk.dim(`  Filter: ${filterQuery}`));
        }

        if (visible.length === 0) {
          lines.push(chalk.dim('  No matches'));
        } else if (filterQuery) {
          // Flat filtered view: no separators, window directly over `visible`.
          const viewportSize = computeViewportSize(visible.length, stdout.rows, 6);
          scrollTop = computeScrollTop(scrollTop, pointer, visible.length, viewportSize);
          if (scrollTop > 0) lines.push(chalk.dim(`  ↑ ${scrollTop} more above`));
          const viewEnd = Math.min(visible.length, scrollTop + viewportSize);
          for (let vi = scrollTop; vi < viewEnd; vi++) {
            const si = visible[vi];
            const choice = selectable[si];
            const active = vi === pointer;
            const isChecked = checked.has(si);
            const box = isChecked ? chalk.green('[✔]') : chalk.dim('[ ]');
            const label = active ? chalk.cyan(choice.name) : choice.name;
            const prefix = active ? chalk.cyan('❯') : ' ';
            lines.push(`${prefix} ${box} ${label}`);
          }
          if (viewEnd < visible.length) {
            lines.push(chalk.dim(`  ↓ ${visible.length - viewEnd} more below`));
          }
        } else {
          // Grouped view: window over the full `choices` array so separators
          // stay attached to their items.
          const windowed = selectable.length > WINDOW_THRESHOLD;
          let viewStart = 0;
          let viewEnd = choices.length;
          if (windowed) {
            const viewportSize = computeViewportSize(choices.length, stdout.rows, 6);
            scrollTop = computeScrollTop(
              scrollTop,
              choiceIndexOf[pointer],
              choices.length,
              viewportSize
            );
            viewStart = scrollTop;
            viewEnd = Math.min(choices.length, scrollTop + viewportSize);
            if (viewStart > 0) lines.push(chalk.dim(`  ↑ ${viewStart} more above`));
          }

          let selectableIdx = 0;
          for (let i = 0; i < choices.length; i++) {
            const choice = choices[i];
            const isSeparator = choice instanceof inquirer.Separator || choice.type === 'separator';
            if (i < viewStart || i >= viewEnd) {
              if (!isSeparator) selectableIdx++;
              continue;
            }
            if (isSeparator) {
              const text = choice.separator || '';
              lines.push(text.trim() ? ` ${text}` : '');
            } else {
              const active = selectableIdx === pointer;
              const isChecked = checked.has(selectableIdx);
              const box = isChecked ? chalk.green('[✔]') : chalk.dim('[ ]');
              const label = active ? chalk.cyan(choice.name) : choice.name;
              const prefix = active ? chalk.cyan('❯') : ' ';
              lines.push(`${prefix} ${box} ${label}`);
              selectableIdx++;
            }
          }

          if (windowed && viewEnd < choices.length) {
            lines.push(chalk.dim(`  ↓ ${choices.length - viewEnd} more below`));
          }
        }

        lines.push('');
        lines.push(chalk.dim('  Press enter when done'));
        stdout.write(lines.join('\n') + '\n');
        linesRendered = lines.length;
      };

      const finish = () => {
        if (linesRendered > 0) {
          stdout.write(`\x1B[${linesRendered}A\x1B[0J`);
        }
        const summary =
          checked.size === 0 ? chalk.dim('none selected') : chalk.cyan(`${checked.size} selected`);
        stdout.write(chalk.green('✔') + ' ' + chalk.bold(message) + ' ' + summary + '\n');
        stdout.write('\x1B[?25h');
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
        resolve(selectable.filter((_, i) => checked.has(i)).map(c => c.value));
      };

      const onKeypress = (ch, key) => {
        if (!key) return;

        if (key.name === 'up' && visible.length > 0) {
          pointer = (pointer - 1 + visible.length) % visible.length;
          render();
        } else if (key.name === 'down' && visible.length > 0) {
          pointer = (pointer + 1) % visible.length;
          render();
        } else if (key.name === 'space') {
          if (visible.length > 0) {
            const si = visible[pointer];
            if (checked.has(si)) {
              checked.delete(si);
            } else {
              checked.add(si);
            }
            render();
          }
        } else if (key.name === 'return') {
          finish();
        } else if (key.name === 'backspace') {
          if (filterable && filterQuery) {
            filterQuery = filterQuery.slice(0, -1);
            applyFilter();
            render();
          }
        } else if (key.name === 'c' && key.ctrl) {
          stdout.write('\x1B[?25h');
          stdin.removeListener('keypress', onKeypress);
          stdin.setRawMode(false);
          stdin.pause();
          process.exit(0);
        } else if (filterable && ch && ch.length === 1 && !key.ctrl && !key.meta) {
          filterQuery += ch;
          applyFilter();
          render();
        }
      };

      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdout.write('\x1B[?25l');
      stdin.on('keypress', onKeypress);
      render();
    });
  }

  /**
   * Prompt user to select multiple items from a list
   * @param {string} message - The prompt message
   * @param {Array<{name: string, value: string, checked?: boolean}>} choices - List of choices
   * @returns {Promise<Array<string>>} Selected values
   */
  static async multiSelect(message, choices) {
    return this._rawMultiSelect(message, choices);
  }

  /**
   * Prompt for password input (hidden)
   * @param {string} message - The prompt message
   * @returns {Promise<string>} User's password
   */
  static async password(message) {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'value',
        message,
      },
    ]);

    return answer.value;
  }
}
