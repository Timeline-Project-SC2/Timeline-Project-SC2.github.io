# Issue-шлюз (Cloudflare Worker) — стадия 2: вход

Тестовый Worker для GitHub-авторизации администратора перед созданием заявки.
Собирает **вход**: одноразовый state/PKCE, обмен кода, идентификацию
пользователя и серверную сессию. **Не** создаёт Issue, не применяет правки
и не публикует ничего — это следующие этапы.

## Что здесь

- `src/index.ts` — HTTP-слой: маршруты `/auth/start`, `/auth/callback`,
  `/auth/status`, `/auth/logout`, `/healthz`. Code и токены не попадают в
  ответы, редиректы и логи.
- `src/oauth-state-do.ts` — Durable Object `OAuthState` с SQLite. Единый
  экземпляр для всех потоков: атомарное одноразовое снятие state и сессии
  хранятся в одной базе с одним писателем. События одноразовости
  (`putIfAbsent`, `DELETE … RETURNING`) выполнены одной SQL-командой.
- `src/issue-gateway/` (вне этого каталога, переиспользуется) — проверенная
  логика state/PKCE, обмена кода и идентификации.

## Почему Durable Object

Одноразовый state нельзя хранить в обычном KV Cloudflare (eventual
consistency позволяет два читающих снять один и тот же state). Durable
Object гарантирует один экземпляр на ключ, SQLite внутри него — атомарные
операции. Локальный SQLite-адаптер в `src/issue-gateway/oauth-sql-store.ts`
проверяет ту же семантику в Node, но не доказывает поведение в runtime —
это доказывают miniflare-тесты ниже.

## Тесты

`tests/worker-runtime.test.mjs` запускает Worker на miniflare (официальный
локальный эмулятор Cloudflare, внутри — workerd) с Durable Objects + SQLite
и mock-GitHub на loopback. Проверяются:

- гонка: 12 параллельных callback на один state → ровно один успех;
- повторное использование state и callback без cookie привязки;
- отказ хранилища → 503, без утечки секретов;
- истечение срока жизни, плановая очистка;
- переживание перезапуска рантайма (persist);
- флаги cookie (Secure, HttpOnly, SameSite=Lax);
- отсутствие кода/секретов/токенов в ответах.

Запуск: `npm test` (файл подхватывается общим `node --test tests/*.test.mjs`)
или `node --test tests/worker-runtime.test.mjs`.

Минiflare — симулятор, а не продакшен: поведение в реальной сети Cloudflare
и защиту от утечек в платформенных логах/Referer/history проверяют только
после развёртывания.

## Переменные окружения (прод)

| Переменная | Тип | Значение |
|---|---|---|
| `GITHUB_CLIENT_ID` | variable | ID OAuth App (не секрет) |
| `GITHUB_CALLBACK_URL` | variable | `https://<worker-domain>/auth/callback` |
| `GITHUB_CLIENT_SECRET` | **secret** | секрет OAuth App |
| `GITHUB_TOKEN_URL` | variable (опц.) | по умолчанию официальный endpoint |
| `GITHUB_USER_URL` | variable (опц.) | по умолчанию официальный endpoint |
| `GITHUB_SCOPES` | variable (опц.) | по умолчанию `public_repo` |
| `SITE_ORIGIN` | variable | куда вернуть браузер после входа |

`FAIL_STORAGE` — только для тестов, в прод не задавать.

## Статус

HOLD: реальное развёртывание, настройка Cloudflare/GitHub и пробная живая
Issue требуют отдельного подтверждения владельца. Создание Issue не
подтверждает применение или публикацию.
