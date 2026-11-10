/**
 * Кэш ассетов в браузере игрока: регистрирует service worker (public/sw.js), только в production-сборке.
 * Версия релиза — VITE_BUILD_ID (задаётся при сборке релиза), иначе путь бандла (хэш меняется вместе с кодом).
 * Смена версии не сбрасывает кэш: sw.js перепроверяет файлы условными запросами и докачивает только изменённые.
 * ?sw=0 — снять service worker и очистить кэш (отладка).
 */
export function registerOfflineCache(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  if (new URLSearchParams(location.search).get('sw') === '0') {
    void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
    void caches.delete('nfr-assets');
    return;
  }
  const version = (import.meta.env.VITE_BUILD_ID as string | undefined) || new URL(import.meta.url).pathname.replace(/\W+/g, '');
  navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`).catch((e) => console.warn('[sw] не зарегистрирован:', e));
}
