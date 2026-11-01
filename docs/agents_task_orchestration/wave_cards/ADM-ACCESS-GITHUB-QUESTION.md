# ADM-ACCESS-GITHUB-QUESTION: вопрос GitHub о гарантиях

> **Статус:** черновик для владельца, никуда не отправлен. Подготовлен после
> [отчёта A0-M2](ADM-ACCESS-QUEUE-PROOF.md); живая очередь остаётся `HOLD`.
> [Индекс](../README.md).

## Куда отправлять

Возможность прямого обращения зависит от тарифов аккаунта и организации; они не
проверены. По [GitHub](https://docs.github.com/en/support/learning-about-github-support/about-github-support),
для большинства вопросов на Free доступно [сообщество](https://github.com/orgs/community/discussions),
а для подходящего платного тарифа — [Support](https://support.github.com/). Ответ
сообщества не обязательно является официальной гарантией. Не прикладывать ключи,
токены, пароли, приватные данные или секретные URL.

## Текст обращения

~~~~text
Subject: Documented ordering and atomicity guarantees for issue-based automation

Hello! We are designing an automated processor for issues in a public repository.
An authorized user manually creates an issue; after GitHub receives it, a trusted
process validates the author and applies changes without a second approval. We need
the earliest submitted request to take priority, and must reject a request if its
title or body was edited before the data write.

We are looking for documented API guarantees, not assumptions based only on normal
behavior or a successful test. If a guarantee is unavailable, please say so.

1. Can GitHub provide a complete, consistent view of all issues created before a
   specific point in time, including across REST API pages, even if an issues.opened
   workflow was delayed or never ran? Is there a documented ordering key that
   distinguishes concurrent submissions with identical timestamps? Please clarify
   whether it represents browser submission, GitHub acceptance, or creation order.

2. If an issues.opened event is not received and the issue is later edited or
   restored, can the original event payload, title and body be recovered reliably?
   What are the documented limits of Issue.lastEditedAt, userContentEdits and title
   rename events after a revision is removed or the history exceeds its retention?

3. Is there a single documented operation that writes a commit only if both the
   issue's title and body are unchanged since submission and its author is still an
   active organization owner at the moment of that write? We understand that
   createCommitOnBranch's expectedHeadOid checks the branch head; does any GitHub
   API offer an atomic condition spanning the issue, membership and branch? We have
   not decided whether a gap between the membership check and the write is acceptable.

Please point to the relevant documentation or state which guarantees are not
provided. We are not asking for credentials or for a custom integration to be built.
Thank you!
~~~~

## Как использовать ответ

Ссылка на официальную гарантию или явное подтверждение её отсутствия важнее обещания
«обычно работает». Не считать ответом доказательство локального теста, таймаут или
предположение о порядке номеров issue. Перед реальным включением остаются проверка
источника данных, роли, восстановления и отдельное решение владельца.
