import { createInterface, emitKeypressEvents } from 'node:readline';
import { Writable } from 'node:stream';
import { searchModels } from './models.mjs';

const colors = { title: 36, selected: 96, success: 32, warning: 33, error: 31, muted: 90 };
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const clearLine = '\r\x1b[2K';

export function color(tone, text, stream = process.stdout) {
  if (!tone || !stream.isTTY || process.env.TERM === 'dumb' || Object.hasOwn(process.env, 'NO_COLOR')) return text;
  return `\x1b[${colors[tone]}m${text}\x1b[0m`;
}

export async function withProgress(label, run, { timeoutMs } = {}) {
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  const animate = interactive && process.env.TERM !== 'dumb';
  let timer;
  let frame = 0;
  let drawn = false;
  let atLineStart = true;
  const startedAt = performance.now();
  const clear = () => {
    if (drawn) process.stderr.write(clearLine);
    drawn = false;
  };
  const stop = () => {
    clearInterval(timer);
    clear();
  };
  const render = () => {
    if (!atLineStart) return;
    const elapsed = Math.floor((performance.now() - startedAt) / 1000);
    const timing = timeoutMs ? ` · ${elapsed} / ${timeoutMs / 1000} с` : '';
    process.stderr.write(clearLine + color('title', `${frames[frame++ % frames.length]} ${label}${timing}`, process.stderr));
    drawn = true;
  };
  const writeOutput = (stream, chunk) => {
    if (stream.isTTY) clear();
    stream.write(chunk);
    if (stream.isTTY) atLineStart = chunk.at(-1) === 10;
  };
  if (animate) {
    render();
    timer = setInterval(render, 90);
    timer.unref();
  } else if (interactive) {
    process.stderr.write(`${label}\n`);
  }
  try {
    return await run({ stop, writeOutput });
  } finally {
    stop();
    if (interactive && !atLineStart) process.stderr.write('\n');
  }
}

function menuHeading(title, preserveOutput = false) {
  process.stdout.write(`${preserveOutput ? '\n' : '\x1b[2J\x1b[H'}${color('title', 'APIHub Auto Setup')}\n\n${title}\n\n`);
}

export const back = Symbol('back');
export const exit = Symbol('exit');

export function terminalLink(url, stream = process.stderr) {
  return stream.isTTY && process.env.TERM !== 'dumb'
    ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`
    : url;
}

async function readLine(prompt, { secret = false } = {}) {
  if (!process.stdin.isTTY) throw new Error('Запустите настройщик в терминале.');
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  emitKeypressEvents(process.stdin, input);
  const shortcuts = 'Esc — назад · Ctrl+C — выйти\n';
  if (secret) process.stderr.write(prompt + shortcuts);
  else {
    output.write(shortcuts);
    input.setPrompt(prompt);
    input.prompt();
  }
  let result;
  const onKey = (_text, key) => {
    if (key?.name === 'escape') {
      result = back;
      input.close();
    }
  };
  const onInterrupt = () => {
    result = exit;
    input.close();
  };
  process.stdin.on('keypress', onKey);
  input.on('SIGINT', onInterrupt);
  try {
    for await (const line of input) return line.trim();
    return result ?? exit;
  } finally {
    process.stdin.off('keypress', onKey);
    input.close();
    (secret ? process.stderr : process.stdout).write('\n');
  }
}

export async function askSecret(prompt) {
  const answer = await readLine(prompt, { secret: true });
  if (answer === back || answer === exit || /^[!-~]+$/.test(answer)) return answer;
  throw new Error('Введите ключ APIHub.');
}

export function askMarketplaceQuestion() {
  menuHeading('Помощник APIHub\nСпросите, где подключить MCP, создать агента или выставить API.');
  return readLine('Вопрос › ');
}

async function choose(title, choices, { previous, canGoBack = false, preserveOutput = false } = {}) {
  if (!process.stdin.isTTY) return choices[0]?.value;
  let index = Math.max(0, choices.findIndex(({ value }) => value === previous));
  const render = () => {
    menuHeading(title, preserveOutput);
    choices.forEach((option, i) => {
      const shortcut = i < 9 ? `${i + 1}.` : '  ';
      const line = `${i === index ? '›' : ' '} ${shortcut} ${option.label}`;
      process.stdout.write(color(i === index ? 'selected' : null, line) + '\n');
    });
    const shortcuts = [
      ...(choices.length > 1 ? ['↑/↓ — выбрать', `1–${Math.min(choices.length, 9)} — по номеру`] : []),
      ...(choices.length ? ['Enter — подтвердить'] : []),
      ...(canGoBack ? ['Esc — назад'] : []),
      'Q — выйти',
    ];
    process.stdout.write(`\n${color('muted', shortcuts.join(' · '))}\n`);
  };
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  try {
    return await new Promise((resolve) => {
      const finish = (value) => {
        process.stdin.off('keypress', onKey);
        resolve(value);
      };
      const onKey = (text, key) => {
        if (key?.name === 'q' || (key?.ctrl && key.name === 'c')) return finish(exit);
        if (key?.name === 'escape' || key?.name === 'backspace') return finish(canGoBack ? back : exit);
        if (choices[index] && (key?.name === 'return' || key?.name === 'enter')) return finish(choices[index].value);
        if (text && /^[1-9]$/.test(text)) {
          const option = choices[Number(text) - 1];
          if (option) return finish(option.value);
        }
        if (choices.length > 1 && (key?.name === 'up' || key?.name === 'down')) {
          const step = key.name === 'up' ? -1 : 1;
          index = (index + step + choices.length) % choices.length;
          render();
        }
      };
      process.stdin.on('keypress', onKey);
      render();
      process.stdin.resume();
    });
  } finally {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
}

export function chooseMode() {
  return choose('Что сделать?', [
    { value: 'configure', label: 'Настроить' },
    { value: 'models', label: 'Дополнительные модели' },
    { value: 'marketplace', label: 'Помощник APIHub' },
    { value: 'change-key', label: 'Сменить ключ APIHub' },
  ]);
}

export function offerAdditionalModels() {
  return choose('Хотите добавить модели к APIHub Auto?', [
    { value: 'launch', label: 'Продолжить с APIHub Auto' },
    { value: 'models', label: 'Выбрать из каталога' },
  ], { canGoBack: true });
}

export async function chooseAdditionalModels(catalog, saved, { offline = false } = {}) {
  const selected = new Map(saved.map((model) => [model.id, model]));
  const current = new Map(catalog.map((model) => [model.id, model]));
  for (const model of saved) {
    if (!current.has(model.id)) current.set(model.id, model);
  }
  const models = [...current.values()];
  let query = '';
  let index = 0;
  let matches = models;
  const render = () => {
    const height = Math.max(2, (process.stdout.rows || 24) - (offline ? 11 : 10));
    const start = Math.max(0, Math.min(index - Math.floor(height / 2), matches.length - height));
    const shown = [...selected.keys()];
    const names = shown.slice(0, 3).join(', ') + (shown.length > 3 ? ` и ещё ${shown.length - 3}` : '');
    const notice = offline ? '\nКаталог недоступен. Показаны сохранённые модели.' : '';
    menuHeading(`Дополнительные модели${notice}\nВыбрано ${shown.length}${names ? ` · ${names}` : ''}\nПоиск › ${query}`);
    if (!matches.length) process.stdout.write('Ничего не найдено.\n');
    matches.slice(start, start + height).forEach((model, offset) => {
      const active = index === start + offset;
      const text = model.name === model.id ? model.id : `${model.name} · ${model.id}`;
      const width = Math.max(15, (process.stdout.columns || 80) - 7);
      const row = `${active ? '›' : ' '} ${selected.has(model.id) ? '[×]' : '[ ]'} ${text.length > width ? text.slice(0, width - 1) + '…' : text}`;
      process.stdout.write(color(active ? 'selected' : null, row) + '\n');
    });
    if (matches.length > height) process.stdout.write(`${start + 1}–${Math.min(start + height, matches.length)} из ${matches.length}\n`);
    process.stdout.write('\n↑/↓ — выбрать · Пробел — отметить · Enter — сохранить · Esc — назад\n');
  };
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  try {
    return await new Promise((resolve) => {
      const finish = (result) => {
        process.stdin.off('keypress', onKey);
        process.stdout.off('resize', render);
        resolve(result);
      };
      const onKey = (text, key) => {
        if (key?.name === 'escape') return finish(back);
        if (key?.ctrl && key.name === 'c') return finish(exit);
        switch (key?.name) {
          case 'up': index = Math.max(0, index - 1); break;
          case 'down': index = Math.max(0, Math.min(index + 1, matches.length - 1)); break;
          case 'return':
          case 'enter':
            return finish([...selected.values()].map((model) => current.get(model.id)));
          case 'space': {
            const model = matches[index];
            if (!model) return;
            if (selected.has(model.id)) selected.delete(model.id);
            else selected.set(model.id, model);
            break;
          }
          default:
            if (key?.name === 'backspace') query = [...query].slice(0, -1).join('');
            else if (key?.ctrl && key.name === 'u') query = '';
            else if (text && !key?.ctrl && !key?.meta && /^[^\u0000-\u001f\u007f-\u009f]+$/u.test(text)) query = (query + text).slice(0, 160);
            else return;
            index = 0;
            matches = searchModels(models, query);
        }
        render();
      };
      process.stdin.on('keypress', onKey);
      process.stdout.on('resize', render);
      render();
      process.stdin.resume();
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export function chooseAgent(harnesses, previous) {
  return choose('Выберите кодинг-агента', harnesses.filter(({ unavailable }) => !unavailable).map((harness) => ({
    value: harness.value,
    label: harness.note ? `${harness.label} — ${harness.note}` : harness.label,
  })), { previous, canGoBack: true });
}

export function chooseAgentAction(harness) {
  const title = [harness.label, harness.note, !harness.available && harness.install].filter(Boolean).join('\n');
  return choose(title, [
    ...(harness.available ? [{ value: 'configure', label: 'Настроить и запустить' }] : []),
    { value: 'settings', label: harness.guide ? 'Инструкция подключения' : 'Настройки' },
    { value: 'restore', label: 'Восстановить настройки' },
  ], { canGoBack: true });
}

export function confirmRestore(summary) {
  return choose(summary, [{ value: 'restore', label: 'Восстановить' }], { canGoBack: true });
}

export function chooseAgentSettings(harness, strategy, { gateway, model, tokenHelpUrl, models = [], saved = [] } = {}) {
  const additional = models.length ? `\nДополнительные модели · ${models.map(({ id }) => id).join(', ')}` : '';
  if (harness.guide) {
    return choose(`${harness.label}\n\n${harness.guide}\n\nBase URL: ${gateway}\nМодель: ${model}${additional}\nКлюч APIHub: ${tokenHelpUrl}`, [], { canGoBack: true });
  }
  const modes = [
    { value: 'optimal', label: 'Сбалансированный — цена и качество' },
    { value: 'cheaper', label: 'Дешёвый — приоритет цены' },
    { value: 'faster', label: 'Быстрый — приоритет скорости' },
    { value: 'reliable', label: 'Стабильный — приоритет надёжности' },
  ];
  const unavailable = harness.value === 'claude-desktop' ? saved.filter((entry) => !models.includes(entry)) : [];
  const desktopNotice = unavailable.length
    ? `\nВ этом профиле пропущены модели без маршрута /messages · ${unavailable.map(({ id }) => id).join(', ')}`
    : '';
  const summary = `Настройки · ${harness.label}\nМодель APIHub Auto · ${harness.endpoint}${additional}${desktopNotice}\n` +
    (harness.strategy ? 'Режим APIHub Auto' : 'Режим · Сбалансированный');
  return choose(summary, harness.strategy ? modes : [], { previous: strategy, canGoBack: true });
}

export function returnToMenu() {
  return choose('Что дальше?', [{ value: back, label: 'В главное меню' }], { preserveOutput: true });
}
