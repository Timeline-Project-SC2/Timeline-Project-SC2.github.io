/* Публичный путь игрока: «Предложить правку» и «Мои заявки».
 * Не применяет правки и не публикует сайт. Точный текст заявки готовит сервер;
 * отправка возможна только после отдельного подтверждения просмотра.
 */
import { escapeHtml } from './config.ts';
import type { AtlasKernel } from './config.ts';
import { PROPERTY_FIELDS, createPropertySession, editProperty, propertyChanges } from './sector-property-session.ts';
import type { PropertySession } from './sector-property-session.ts';
import type { PropertyDataset, PropertyField } from './sector-property-overlay.ts';
import { preparePropertyDraft } from './sector-property-draft.ts';
import { newRequestId, preparePropertyPacket } from './sector-property-packet.ts';
import {
  SUBMIT_MESSAGES, preparePropertySubmission, readGatewayUrl, readMyRequests,
  submitPropertyPacket, logoutPropertySession,
} from './sector-property-submit.ts';
import type { OwnRequestView, PreparedSubmission, SubmitOutcome } from './sector-property-submit.ts';

const FIELD_LABELS: Record<PropertyField, string> = {
  name: 'Название', type: 'Тип', faction: 'Фракция', description: 'Описание', source_url: 'Ссылка на источник',
};
export function requestStatusLabel(request: Pick<OwnRequestView, 'status' | 'issueState'>): string {
  if (request.status === 'prepared') return 'Подготовлена, не отправлена';
  if (request.status === 'reserved') return 'Отправка не подтверждена; повторите ту же версию';
  if (request.issueState === 'closed') return 'Нить закрыта; это не доказывает применение';
  return 'Создана, ждёт чтения владельцем';
}
export function changeLine(change: OwnRequestView['changes'][number]): string {
  return `${change.dataset === 'systems' ? 'Система' : 'Место'} ${change.recordId} · ${FIELD_LABELS[change.field]}: ${change.before || '∅'} → ${change.after || '∅'}`;
}
interface EditState {
  readonly dataset: PropertyDataset;
  readonly recordId: string;
  session: PropertySession;
  submission: PreparedSubmission | null;
  submissionSnapshot: string | null;
  acknowledged: boolean;
  confirmed: boolean;
  thread: { threadId: string; number?: number } | null;
  notice: string | null;
  outcome: SubmitOutcome | null;
}
export interface SectorPropertyRequestUiApi {
  bind(): void;
  open(dataset: PropertyDataset, recordId: string): void;
  openRequests(): void;
  destroy(): void;
}
export function createSectorPropertyRequestUi(kernel: AtlasKernel): SectorPropertyRequestUiApi {
  const doc = kernel.doc;
  let modal: HTMLElement | null = null;
  let edit: EditState | null = null;
  let busy = false;
  let requests: readonly OwnRequestView[] = [];
  let hasMore = false;
  let openLimit: number | null = null;
  let requestsNotice: string | null = null;
  let returnFocus: HTMLElement | null = null;
  const env = () => ({ gatewayUrl: readGatewayUrl(doc.querySelector('meta[name="issue-gateway"]')), origin: location.origin });
  const factions = () => new Set(kernel.data.factionsByName().keys());

  function ensureModal(): HTMLElement {
    if (modal !== null) return modal;
    const node = doc.createElement('div');
    node.className = 'modal-backdrop property-request-backdrop';
    node.hidden = true;
    node.innerHTML = '<section class="info-modal panel property-request-modal" role="dialog" aria-modal="true" aria-labelledby="propertyRequestTitle">'
      + '<div class="modal-head"><div><div class="eyebrow"><span class="eyebrow-line"></span> ЗАЯВКИ НА СВОЙСТВА</div><h2 id="propertyRequestTitle">Мои заявки</h2></div>'
      + '<button class="icon-button" type="button" data-request-action="close" aria-label="Закрыть">×</button></div>'
      + '<div class="modal-body" data-request-body></div>'
      + '<div class="modal-foot property-request-foot"><span>НЕ ПРИМЕНЯЕТ ПРАВКУ</span><span>НЕ ОБНОВЛЯЕТ САЙТ</span></div></section>';
    node.addEventListener('click', (event) => { if (event.target === node) close(); });
    node.addEventListener('click', onClick);
    node.addEventListener('change', onChange);
    node.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Escape') { event.stopPropagation(); close(); } });
    doc.body.appendChild(node);
    modal = node;
    return node;
  }
  function body(): HTMLElement { return ensureModal().querySelector<HTMLElement>('[data-request-body]')!; }
  function title(text: string): void { ensureModal().querySelector('#propertyRequestTitle')!.textContent = text; }
  function show(): void {
    returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    ensureModal().hidden = false;
    ensureModal().querySelector<HTMLElement>('[data-request-action="close"]')?.focus();
  }
  function close(): void { if (modal !== null) modal.hidden = true; returnFocus?.focus(); returnFocus = null; }
  function loginHtml(returnTo: 'requests'): string {
    const gateway = env().gatewayUrl;
    return gateway === null ? '<p>Приём заявок не настроен.</p>'
      : `<p><a class="property-request-login" href="${escapeHtml(gateway)}/auth/start?return=${returnTo}" target="_blank" rel="noopener">Войти через GitHub</a> <span>Откроется новая вкладка; черновик в этой вкладке останется.</span></p>`;
  }
  function renderEdit(): void {
    if (edit === null) return;
    title('Предложить правку');
    const current = edit.session.present[0]!;
    const snapshot = edit.session.snapshots[0]!;
    const changes = propertyChanges(edit.session);
    const { problems } = preparePropertyDraft(edit.session, factions());
    const fields = PROPERTY_FIELDS.map((field) => {
      const value = escapeHtml(current[field]);
      return `<label class="property-request-field"><span>${FIELD_LABELS[field]}</span>${field === 'description'
        ? `<textarea data-request-field="${field}" rows="4">${value}</textarea>`
        : `<input data-request-field="${field}" value="${value}">`}</label>`;
    }).join('');
    const summary = changes.map((change) => `<li>${escapeHtml(`${FIELD_LABELS[change.field]}: ${change.before || '∅'} → ${change.after || '∅'}`)}</li>`).join('');
    const issues = problems.map((problem) => `<li>${escapeHtml((problem.severity === 'error' ? 'Ошибка: ' : 'Внимание: ') + problem.message)}</li>`).join('');
    const prepared = edit.submission;
    body().innerHTML = `<p class="property-request-object">${escapeHtml(snapshot.dataset === 'systems' ? 'Система' : 'Место')} · ID ${escapeHtml(edit.recordId)} · ${escapeHtml(snapshot.fields.name.effective)}</p>`
      + '<p>Правка не появится сразу: её прочитает владелец организации. Чужие заявки вам не видны. Не включайте секреты и личные данные.</p>'
      + fields + `<p>Изменений: ${changes.length}</p>` + (summary ? `<ul>${summary}</ul>` : '')
      + (issues ? `<ul class="property-request-issues" role="status">${issues}</ul>` : '')
      + (edit.notice === null ? '' : `<p role="status">${escapeHtml(edit.notice)}</p>`)
      + (edit.outcome?.status === 'unauthorized' ? loginHtml('requests') : '')
      + `<div class="property-request-actions"><button type="button" data-request-action="prepare" ${busy || changes.length === 0 ? 'disabled' : ''}>${busy ? 'Подготовка…' : 'Подготовить текст на сервере'}</button>`
      + (edit.thread === null ? '' : `<button type="button" data-request-action="new-thread">Начать новую нить</button>`) + '</div>'
      + (prepared === null ? '' : `<section aria-label="Точный текст заявки"><h3>Точный текст будущей заявки</h3><p><strong>${escapeHtml(prepared.title)}</strong></p><pre class="property-request-preview">${escapeHtml(prepared.body)}</pre>`
        + `<label><input type="checkbox" data-request-action="ack" ${edit.acknowledged ? 'checked' : ''}> Я проверил содержимое; заявка доступна только мне на сайте и владельцу организации.</label>`
        + `<div class="property-request-actions"><button type="button" data-request-action="confirm" ${edit.acknowledged && !edit.confirmed ? '' : 'disabled'}>Подтвердить просмотр</button>`
        + `<button type="button" data-request-action="send" ${edit.confirmed && !busy ? '' : 'disabled'}>${busy ? 'Отправка…' : 'Отправить заявку'}</button></div>`
        + (edit.confirmed ? '<p role="status">Просмотр подтверждён. Отправка — отдельное действие.</p>' : '')
        + (edit.outcome === null ? '' : `<p role="status">${escapeHtml(SUBMIT_MESSAGES[edit.outcome.status])}${edit.outcome.number === undefined ? '' : ` Номер нити: #${edit.outcome.number}.`}</p>`)
        + '</section>')
      + '<p><button type="button" data-request-action="requests">Мои заявки</button></p>';
  }
  function renderRequests(): void {
    title('Мои заявки');
    const cards = requests.map((request) => `<article class="property-request-card"><h3>${request.number === null ? 'Без номера' : `Нить #${request.number}`} · ${escapeHtml(requestStatusLabel(request))}</h3>`
      + `<p>Версия <code>${escapeHtml(request.requestId)}</code>${request.threadId === request.requestId ? ' (корень нити)' : ` в нити <code>${escapeHtml(request.threadId)}</code>`}</p>`
      + `<p>Подготовлена: ${escapeHtml(request.createdAt)}</p><ul>${request.changes.map((change) => `<li>${escapeHtml(changeLine(change))}</li>`).join('')}</ul></article>`).join('');
    body().innerHTML = '<p>Здесь только ваши заявки. Закрытая нить не означает, что правка применена или сайт обновлён.</p>'
      + (openLimit === null ? '' : `<p>Лимит открытых нитей: ${openLimit}. Новые версии той же нити не увеличивают счётчик.</p>`)
      + (requestsNotice === null ? '' : `<p role="status">${escapeHtml(requestsNotice)}</p>`)
      + `<div class="property-request-actions"><button type="button" data-request-action="refresh" ${busy ? 'disabled' : ''}>${busy ? 'Загрузка…' : 'Обновить'}</button>`
      + `<button type="button" data-request-action="logout" ${busy ? 'disabled' : ''}>Выйти</button></div>`
      + (requestsNotice === 'Нужен вход через GitHub.' ? loginHtml('requests') : '')
      + (cards || '<p>Заявок пока нет.</p>')
      + (hasMore ? `<div class="property-request-actions"><button type="button" data-request-action="more" ${busy ? 'disabled' : ''}>Показать ещё</button></div>` : '');
  }
  async function loadRequests(append = false): Promise<void> {
    if (busy) return;
    busy = true; requestsNotice = null; renderRequests();
    try {
      const before = append && requests.length ? Math.min(...requests.map((request) => request.updatedAt)) : undefined;
      const result = await readMyRequests(env(), before);
      if (result.status === 'ready') {
        requests = append ? [...requests, ...result.requests] : result.requests;
        hasMore = result.hasMore; openLimit = result.openLimit;
      } else {
        requestsNotice = result.status === 'unauthorized' ? 'Нужен вход через GitHub.'
          : result.status === 'disabled' ? SUBMIT_MESSAGES.disabled : SUBMIT_MESSAGES.unavailable;
        if (!append) { requests = []; hasMore = false; }
      }
    } finally { busy = false; renderRequests(); }
  }
  async function prepare(): Promise<void> {
    if (edit === null || busy) return;
    const sessionAtStart = edit.session;
    busy = true; edit.notice = null; edit.outcome = null; renderEdit();
    try {
      const requestId = edit.submission?.requestId ?? newRequestId(Date.now(), () => crypto.getRandomValues(new Uint8Array(32)));
      const threadId = edit.submission?.threadId ?? edit.thread?.threadId ?? requestId;
      const review = await preparePropertyPacket(edit.session, factions(), requestId, threadId);
      if (review === null || review.status !== 'ready' || review.draft === null) {
        edit.notice = review?.errors[0] ?? 'Заявка не готова: проверьте правки.'; edit.submission = null; return;
      }
      const prepared = await preparePropertySubmission(review.draft, env());
      if (edit === null || edit.session !== sessionAtStart) return;
      if (prepared.status !== 'prepared') {
        edit.outcome = { status: prepared.status };
        edit.notice = SUBMIT_MESSAGES[prepared.status];
        return;
      }
      edit.submission = prepared; edit.submissionSnapshot = review.draftSnapshot; edit.acknowledged = false; edit.confirmed = false;
      edit.notice = 'Сервер добавил автора и время. Проверьте точный текст и подтвердите просмотр.';
    } catch { edit.notice = SUBMIT_MESSAGES.unavailable; }
    finally { busy = false; renderEdit(); }
  }
  async function send(): Promise<void> {
    if (edit === null || edit.submission === null || !edit.confirmed || busy) return;
    const submission = edit.submission;
    const draft = preparePropertyDraft(edit.session, factions()).draft;
    if (draft === null || edit.submissionSnapshot === null || JSON.stringify(draft) !== edit.submissionSnapshot) {
      edit.notice = 'Содержимое изменилось: подготовьте текст заново.'; edit.submission = null; edit.confirmed = false; renderEdit(); return;
    }
    busy = true; renderEdit();
    try {
      const outcome = await submitPropertyPacket(submission, env());
      if (edit === null) return;
      edit.outcome = outcome; edit.notice = SUBMIT_MESSAGES[outcome.status];
      if (outcome.status === 'created' || outcome.status === 'existing') {
        edit.thread = { threadId: submission.threadId, ...(outcome.number === undefined ? {} : { number: outcome.number }) };
      }
    } catch { if (edit !== null) { edit.outcome = { status: 'unavailable' }; edit.notice = SUBMIT_MESSAGES.unavailable; } }
    finally { busy = false; renderEdit(); }
  }
  function onChange(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (target === null || edit === null) return;
    const field = target.getAttribute('data-request-field') as PropertyField | null;
    if (field !== null && PROPERTY_FIELDS.includes(field)) {
      edit.session = editProperty(edit.session, edit.dataset, edit.recordId, field, (target as HTMLInputElement).value);
      edit.submission = null; edit.submissionSnapshot = null; edit.acknowledged = false; edit.confirmed = false; edit.notice = null; edit.outcome = null;
      renderEdit();
      return;
    }
    if (target.getAttribute('data-request-action') === 'ack') {
      edit.acknowledged = (target as HTMLInputElement).checked; edit.confirmed = false; renderEdit();
    }
  }
  function onClick(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-request-action]');
    const action = target?.getAttribute('data-request-action');
    if (!action) return;
    if (action === 'close') close();
    else if (action === 'requests') { edit = null; renderRequests(); void loadRequests(); }
    else if (action === 'refresh') void loadRequests();
    else if (action === 'more') void loadRequests(true);
    else if (action === 'logout') { busy = true; renderRequests(); void logoutPropertySession(env()).finally(() => { busy = false; requests = []; void loadRequests(); }); }
    else if (action === 'prepare') void prepare();
    else if (action === 'confirm' && edit !== null && edit.acknowledged) { edit.confirmed = true; renderEdit(); }
    else if (action === 'send') void send();
    else if (action === 'new-thread' && edit !== null) { edit.thread = null; edit.submission = null; edit.submissionSnapshot = null; edit.confirmed = false; edit.acknowledged = false; edit.notice = 'Следующая заявка начнёт новую нить.'; renderEdit(); }
  }
  function open(dataset: PropertyDataset, recordId: string): void {
    const snapshot = kernel.data.propertySnapshots().find((item) => item.dataset === dataset && item.recordId === recordId);
    if (!snapshot) { kernel.app.toast('Снимок свойств недоступен: объект не сопоставлен однозначно.'); return; }
    let session: PropertySession;
    try { session = createPropertySession([snapshot], kernel.data.propertyContentRevision()); }
    catch { kernel.app.toast('Снимок свойств повреждён; заявка не открыта.'); return; }
    edit = { dataset, recordId, session, submission: null, submissionSnapshot: null, acknowledged: false, confirmed: false, thread: null, notice: null, outcome: null };
    renderEdit(); show();
  }
  function openRequests(): void { edit = null; renderRequests(); show(); void loadRequests(); }
  function bind(): void {
    doc.getElementById('propertyRequestsOpen')?.addEventListener('click', openRequests);
    if (new URLSearchParams(location.search).get('requests') === '1') openRequests();
  }
  function destroy(): void { modal?.remove(); modal = null; }
  return { bind, open, openRequests, destroy };
}
