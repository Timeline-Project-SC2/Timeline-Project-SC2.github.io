# Issue-шлюз (Cloudflare Worker) — стадия 2: вход

Тестовый Worker для GitHub-авторизации администратора и отправки заявки на
свойства точек. Собирает **вход** (одноразовый state/PKCE, обмен кода,
идентификация, серверная сессия) и **создание Issue** по канонической заявке.
**Не** применяет правки и не публикует ничего — это следующий этап.

## Что здесь

- `src/index.ts` — HTTP-слой: маршруты `/auth/start`, `/auth/callback`,
  `/auth/status`, `/auth/logout`, `/healthz`, `POST /issues/submit`
  (+ `OPTIONS` preflight). Code и токены не попадают в ответы, редиректы и
  логи.
- `src/issue-gateway/` (вне этого каталога): контракт заявки
  (`property-issue-contract.ts`) и сообщения Issues (`github-issues.ts`).
  Отправка требует точный `Origin` из `SITE_ORIGIN`, действующую сессию и
  каноническое тело; перед созданием ищется уже созданная заявка с тем же
  `requestId`, поэтому повтор не создаёт дубль. Cookie сессии —
  `SameSite=None`, потому что сайт и Worker находятся на разных сайтах;
  компенсация — проверка `Origin` и JSON-тело (без preflight такой запрос
  сторонний сайт выполнить не может).
- `src/oauth-state-do.ts` — Durable Object `OAuthState` с SQLite. Единый
  экземпляр для всех потоков: атомарное одноразовое снятие state и сессии
  хранятся в одной базе с одним писателем. События одноразовости
  (`putIfAbsent`, `DELETE … RETURNING`) выполнены одной SQL-командой.
  Внешняя поверхность DO — только внутренняя HTTP-шина (`stub.fetch`):
  `/store-put`, `/store-take`, `/session-*`, `/cleanup`.
- `src/issue-gateway/` (вне этого каталога, переиспользуется) — проверенная
  логика state/PKCE, обмена кода и идентификации. Обмен с GitHub идёт с
  `redirect: 'manual'` (workerd не поддерживает `'error'`), 3xx трактуется
  как `unavailable`.
- `triggers.crons` (`wrangler.jsonc`) → `scheduled()` в `src/index.ts`
  вызывает `/cleanup` у DO по той же шине: плановая очистка истёкших
  state/сессий раз в час.

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

Отправка проверяется отдельно: `tests/worker-submit.test.mjs` (13 проверок на
miniflare с фиктивным GitHub) и офлайн-`tests/issue-github-issues.test.mjs`.

Запуск: `npm test` (файлы подхватываются общим `node --test tests/*.test.mjs`)
или `node --test tests/worker-runtime.test.mjs tests/worker-submit.test.mjs`.

Тестовый fetch идёт с `redirect: 'manual'`: 302 Worker'а на GitHub-авторизацию
не уводит undici во внешний интернет (в песочнице — чужой TLS, в CI — реальные
запросы к github.com из тестов).

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
| `SITE_ORIGIN` | variable | origin сайта: возврат после входа **и** разрешённый источник отправки (обязателен) |
| `GITHUB_API_BASE` | variable (опц.) | заменяемый базовый адрес GitHub API для тестов; в проде не задаётся |

`FAIL_STORAGE` — только для тестов, в прод не задавать.

Не-секретные переменные задаются в разделе `vars` файла `wrangler.jsonc` или
через dashboard (команды `wrangler variables put` в wrangler 4.161 нет);
секреты — только `wrangler secret put`, в конфиге и репозитории не хранятся.

## Статус

HOLD: реальное развёртывание, настройка Cloudflare/GitHub и пробная живая
Issue требуют отдельного подтверждения владельца. Создание Issue не
подтверждает применение или публикацию. Применение правки в
`data/sector-property-overlay.json` и обновление сайта — следующий этап и в
этом Worker'е не реализованы. Адрес шлюза в сайте задаётся только сборкой
(`ATLAS_ISSUE_GATEWAY_URL`); без него кнопка отправки недоступна.
