# ADM-ACCESS-KEY-CRITIC: независимая оценка защиты ключа

> **Статус:** отдельный отчёт `rc-08` [получен](ADM-ACCESS-KR-REPORT.md): хранение
> ключа, read-only тест и живая запись — `HOLD`. Отчёт воркера 2 —
> [A0-K](ADM-ACCESS-K-REPORT.md); ключ и настройки помощнику не передавались.
>
> [Подключение](ADM-ACCESS-INTEGRATION.md) · [задание воркера 2](ADM-ACCESS-KEY-REVIEW.md) ·
> [прежний HOLD](ADM-ACCESS-R-REPORT.md) · [индекс](../README.md).

## Задание: независимый критик rc-08 → A0-K-R

Задание выполнено в **прежнем независимом чате критика rc-08**, не воркера 2;
текст ниже исторический, повторно не выдавать. Это отдельный гейт безопасности ключа.

~~~~text
Ты — независимый rc-08, не воркер 2. Проведи red-team кандидата хранения ключа
GitHub App после A0-K. Правила role card и протокола: никакого исполнения кода,
тестов и workflow; источники только документация, Git-метаданные, read-only метаданные
GitHub и официальные документы. OWNED_FILES: пусто; FORBIDDEN_FILES: все.

Не меняй ветки, данные, правила, окружения, Secrets, App, issue и настройки; не
создавай PR, не запускай код или API как настоящий App, не проверяй реальных членов.
Не проси и не принимай ключи, токены, пароли или коды; не перечисляй и не читай секреты.
При 403/недоступности отметь неизвестно — права не повышать и защиты не обходить.

Вход: base main 70cd3c19f98faac79974fd9b5cc258976acf1a92. Документы с отчётом
и планом находятся в ветке arena/91fe7cda-timeline-project-sc2-github-io. Без
переключения ветки выполни read-only Git-команды:
  git fetch origin arena/91fe7cda-timeline-project-sc2-github-io
  git rev-parse FETCH_HEAD
  git ls-remote --heads origin arena/91fe7cda-timeline-project-sc2-github-io
Сверь и сообщи SHA FETCH_HEAD и удалённого HEAD. Прочитай документы по этому SHA:
  git show FETCH_HEAD:docs/agents_task_orchestration/wave_cards/ADM-ACCESS-K-REPORT.md
  git show FETCH_HEAD:docs/agents_task_orchestration/wave_cards/ADM-ACCESS-INTEGRATION.md
  git show FETCH_HEAD:docs/agents_task_orchestration/wave_cards/ADM-ACCESS-KEY-REVIEW.md
Прочитай правила роли rc-08 и протокол из документации. Если документы недоступны
или SHA не совпал, остановись и сообщи; не утверждай, что проверил план. Если main
изменился, укажи это; не переноси автоматически выводы.

Контекст владельца: App создан; скриншот установки показывает Read access to members
и No repositories, Developed by — организация, но аккаунт установки на кадре не виден.
Владелец сообщил, что скачал .pem; он не передавал его помощнику, наличие Actions-
секрета неизвестно. Цель — после ручной отправки issue автоматически обработать её
без второй ручной модерации, с результатом в issue и отдельными уведомлениями Discord.
Планеты на паузе; Sheets и живые данные не менять; старый HOLD по очереди действует.

По отчёту воркера 2 на 70cd3c1: check.yml на PR исполняет код и зависимости PR;
секрет App в текущих workflow не найден. На базе не найдены workflows issues,
pull_request_target или workflow_run. Actions закреплены тегами, а npm ci и Pillow —
зависимости с риском цепочки поставок; sync содержит другие секреты. Это не полный
аудит. Воркер имел HEAD 661165b; Гайдлайнер по git diff --name-only подтвердил, что
между 661165b и 70cd3c1 отличаются только документы, не код и workflow.

По read-only метаданным, доступный ruleset main сейчас показывает creation/deletion;
ранее перед #341 ответ содержал также другие правила. Кто, когда и почему изменил
результат — неизвестно. Полные branch protection и Actions/default-token permissions
воркеру вернули 403; github-pages имеет protected branches и admin bypass. Это НЕ
подтверждает защиту будущего окружения. Параметры и полномочия могут меняться вне Git.

Кандидат воркера: отдельный environment secret, выбранная ветка main, без обязательного
reviewer на каждую заявку; защита изменения workflow/его кода и отдельный контроль
workflow_dispatch. Это предложение, не подтверждённая настройка и не PASS.

Проверь и дай три РАЗДЕЛЬНЫХ вердикта с условиями:
A. STORE: можно ли вообще размещать .pem в выбранном хранилище при имеющихся фактах?
   Чем environment отличается от repository secret? Какие владельцы/субъекты могут
   изменить или запустить доверенный workflow, сослаться на environment и обойти гейт?
   Покажи, как уточнить права и target установки без ключа и изменения настроек.
B. READ-ONLY TEST: что нужно до однократной проверки App и активного Owner организации?
   Оцени явную установку организации, выбранный main/ref, доверенный workflow,
   ограничение полномочий, обработку недоверенной issue, подмену PR/артефактов и
   зависимостей, отсутствие секретов и приватного членства в логах и Discord, а также
   безопасный тест с фиктивными данными. Укажи, что владелец подтверждает до теста.
C. LIVE APPLY: сохраняется ли прежний HOLD для порядка первого Submit, исходного
   снимка, отзыва роли, записи, текущего sync и подтверждённой публикации? PASS на
   STORE или TEST не снимает HOLD на автоматическую запись.

Учти: GitHub сверяет ограничения environment с GITHUB_REF; pull_request_target и
issues могут идти с ref базы, что не делает их payload или checkout доверенными.
Protected branches only при отсутствии branch protection может разрешить все ветки;
selected main точнее, но само по себе не ограничивает авторов и не проверяет код.
Не вводи reviewer на каждую обычную заявку как решение без отдельного выбора владельца.

При разборе токена проверь официальные docs actions/create-github-app-token: при пустых
owner/repositories используется текущий репозиторий; явный owner без repositories —
все репозитории, доступные установке; по умолчанию токен наследует её разрешения.
Будущее расширение прав App может увеличить последствия утечки того же .pem.
Не объявляй работоспособность конкретной установки проверенной без реального теста.

При отзыве оцени: DELETE /installation/token отзывает используемый для этого вызова
токен, а не доказанно все неизвестные токены. GitHub документирует приостановку
установки при подозрении на утечку; её влияние и путь восстановления надо уточнить.
Приведи минимум три конкретных сценария отказа, стоимость, допущения и недоказанное.

Отчёт до 25 строк: HEAD и SHA входного плана, A/B/C и условия каждого, blocker с
фактами или источниками, минимальные действия владельца и отдельно непроверенное.
Не выдавай разрешение на запись, отключение защиты или секреты вместо владельца.
~~~~

## Источники для критика

- [Правила и секреты GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use),
  [окружения и GITHUB_REF](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
- [Create GitHub App Token: owner, repositories и permissions](https://github.com/actions/create-github-app-token/blob/main/README.md#inputs).
- [Отзыв применяемого installation token](https://docs.github.com/en/rest/apps/installations),
  [приостановка установки](https://docs.github.com/en/apps/maintaining-github-apps/suspending-a-github-app-installation).
