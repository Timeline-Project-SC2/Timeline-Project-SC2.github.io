# Issue-шлюз (Cloudflare Worker) — приватные заявки v2

Статус: **локальный код и тесты, ничего не развёрнуто**. Живая отправка,
применение правки, коммит слоя и публикация — `HOLD` до отдельного разрешения
владельца. Создание Issue не доказывает ни применение, ни публикацию.

Назад: [контракт и отправка](../docs/handoff/sector-property-issue-submission.md) ·
[приватная цепочка](../docs/handoff/property-request-private-chain.md) · [индекс](../docs/README.md).

## Что здесь

- `src/index.ts` — HTTP-слой: `/auth/start`, `/auth/callback`, `/auth/status`,
  `/auth/logout`, `/healthz`, `POST /issues/prepare`, `POST /issues/submit`,
  `GET /issues/mine` (+ `OPTIONS` preflight). Вход запрашивает только личность
  (`scope=''`); токен пользователя используется для `/user` и не хранится.
- `src/oauth-state-do.ts` — Durable Object `OAuthState` с SQLite:
  `identity_sessions`, `property_requests`, атомарные резерв/квота/список.
  Старая таблица `oauth_sessions` с токенами удаляется при старте.
- `../src/issue-gateway/github-app.ts` — короткоживущий токен установки App,
  суженный до одного приватного репозитория и `Issues: write`.
- `../src/issue-gateway/github-issues.ts` — корень нити создаётся как Issue,
  новая версия — комментарием; `PATCH`/`PUT` нет. Цель сверяется по ID,
  приватности, организации и включённым Issues.
- `triggers.crons` → `/cleanup`: истёкшие state/сессии и подготовленные, но не
  отправленные черновики старше суток. Резервы и созданная история не удаляются.

## Маршруты заявок

| Маршрут | Тело/параметры | Результат |
|---|---|---|
| `POST /issues/prepare` | `{draft}` v2 без автора | сервер добавляет автора/время, возвращает точный текст и отпечаток |
| `POST /issues/submit` | `{requestId,fingerprint}` | создаёт корень/версию только после просмотра; повтор идемпотентен |
| `GET /issues/mine?before=` | cookie сессии | только свои версии, курсор, лимит открытых нитей |

Изменяющие маршруты требуют точный `Origin` из `SITE_ORIGIN`, JSON-тело и
сессию. Cookie сессии — `SameSite=None; Secure; HttpOnly`, срок 7 суток.
Неизвестный результат создания держит резерв 30 секунд; немедленный повтор не
идёт в GitHub, затем восстановление ищет уже созданную заявку. Закрытая нить
не принимает новую версию.

## Переменные окружения

| Переменная | Тип | Значение |
|---|---|---|
| `SITE_ORIGIN` | variable | origin сайта; без него изменяющие маршруты закрыты |
| `GITHUB_CLIENT_ID` | variable | Client ID OAuth App для входа |
| `GITHUB_CALLBACK_URL` | variable | `https://<worker-domain>/auth/callback` |
| `GITHUB_CLIENT_SECRET` | **secret** | секрет OAuth App |
| `PROPERTY_REPOSITORY_ID` | variable | ID приватного репозитория заявок |
| `PROPERTY_REPOSITORY` | variable | `Timeline-Project-SC2/<private-repo>`, не публичный сайт |
| `GITHUB_APP_CLIENT_ID` | variable | Client ID GitHub App-бота |
| `GITHUB_APP_INSTALLATION_ID` | variable | ID установки App в организации |
| `GITHUB_APP_PRIVATE_KEY` | **secret** | PEM-ключ App (PKCS#1 или PKCS#8) |
| `PROPERTY_OPEN_LIMIT` | variable | целое 1–20; без значения приём выключен |
| `GITHUB_API_BASE` | variable (опц.) | mock API в тестах; в проде не задаётся |
| `GITHUB_TOKEN_URL`, `GITHUB_USER_URL` | variable (опц.) | mock OAuth в тестах |

`FAIL_STORAGE` — только для тестов. `GITHUB_SCOPES` удалён: пользователю не
выдаются права на репозитории. Секреты не коммитить и не передавать в чате.

## Тесты

- `tests/worker-runtime.test.mjs` — OAuth/state/cookie/очистка на miniflare.
- `tests/worker-submit.test.mjs` — prepare/submit/mine, App-токен, нити, квота,
  закрытая нить, неизвестный результат, logout.
- `tests/issue-github-app.test.mjs` — RS256, сужение токена, отказы.
- `tests/issue-github-issues.test.mjs` — фиктивный Issues API, поиск, комментарии.

Запуск: `node --test tests/worker-runtime.test.mjs tests/worker-submit.test.mjs`.
Miniflare — симулятор, не продакшен: реальная сеть Cloudflare, платформенные
логи и браузерная приёмка проверяются только после развёртывания.

## Перед включением

1. Владелец подтверждает приватный репозиторий, App, установку и лимит.
2. Секреты задаются в Cloudflare, не в репозитории.
3. Сборка сайта получает `ATLAS_ISSUE_GATEWAY_URL=https://<worker-domain>`.
4. Отдельное разрешение на пробную живую Issue.
5. Применение и публикация остаются выключенными до следующего этапа.
