/**
 * Экран загрузки (#loading в index.html): полоса прогресса по этапам старта.
 * Внутри этапа прогресс — доля завершённых fetch (FileLoader/GLTFLoader тоже ходят через fetch):
 * начатые считает обёртка window.fetch, завершённые (тело получено целиком) — PerformanceObserver.
 * Полоса только растёт; в конце этапа добегает до его границы.
 */
const root = document.getElementById('loading');
const bar = document.getElementById('loading-bar');
const label = document.getElementById('loading-text');

let from = 0, to = 0, shown = 0;
let started = 0, done = 0;

if (root) {
  const origFetch = window.fetch.bind(window);
  window.fetch = (...args: Parameters<typeof fetch>) => { started++; render(); return origFetch(...args); };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if ((e as PerformanceResourceTiming).initiatorType === 'fetch') done++;
      render();
    }).observe({ type: 'resource' });
  } catch { /* старый браузер — прогресс только по этапам */ }
}

function render(): void {
  if (!root || !bar) return;
  const frac = started > 0 ? Math.min(1, done / started) : 0;
  shown = Math.max(shown, from + (to - from) * frac);
  bar.style.width = `${(shown * 100).toFixed(1)}%`;
}

export const loading = {
  /** Начать этап: полоса дойдёт до `until` (0…1), когда завершатся запросы этапа. */
  stage(until: number, text: string): void {
    shown = Math.max(shown, to);
    from = shown; to = until;
    started = 0; done = 0;
    if (label) label.textContent = text;
    render();
  },
  /** Всё готово — дождаться первого кадра и убрать экран. */
  finish(): void {
    if (!root) return;
    from = to = shown = 1; render();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.add('done');
      setTimeout(() => root.remove(), 600);
    }));
  },
  /** Ошибка старта: экран загрузки не должен закрывать #err. */
  fail(): void { root?.remove(); },
};
