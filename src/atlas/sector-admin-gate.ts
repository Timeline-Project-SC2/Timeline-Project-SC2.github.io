/** Публичный тестовый барьер интерфейса, не средство авторизации или защиты данных. */
export const PUBLIC_TEST_CODE = 'KP-ADM-DEMO-27';
export const ADMIN_SESSION_MARKER_KEY = 'timeline-admin-demo-access';
export const ADMIN_SESSION_END_MESSAGE = 'Сеанс завершён. Администрирование окончено.';
const ADMIN_SESSION_MARKER_VALUE = 'granted';
const ADMIN_ACCESS_QUERY_PARAM = 'adminAccess';
const ADMIN_SESSION_END_QUERY_PARAM = 'adminSession';
const ADMIN_SESSION_END_QUERY_VALUE = 'ended';
const ADMIN_SUCCESS_MESSAGE = 'Доступ Администратора получен. Права расширены.';
const ADMIN_NOTICE_TYPING_MS = 45;
const ADMIN_NOTICE_SHOW_MS = 5000;
const ADMIN_NOTICE_FADE_MS = 400;
const ADMIN_ACCESS_NOTICE_CLASS = 'admin-access-notice';
const ADMIN_SESSION_END_NOTICE_CLASS = 'admin-session-end-notice';
let adminNoticeTypingTimer: number | null = null;
let adminNoticeHideTimer: number | null = null;
let adminNoticeFadeTimer: number | null = null;

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function isCorrectPublicTestCode(value: string): boolean {
  return value.trim() === PUBLIC_TEST_CODE;
}

export type GateAttemptResult = 'granted' | 'invalid' | 'locked';

export function createGateAttemptController(): {
  inputChanged(): void;
  submit(value: string): GateAttemptResult;
} {
  let locked = false;
  return {
    inputChanged(): void { locked = false; },
    submit(value: string): GateAttemptResult {
      if (locked) return 'locked';
      if (isCorrectPublicTestCode(value)) return 'granted';
      locked = true;
      return 'invalid';
    },
  };
}

export function hasAdminSessionMarker(storage: Pick<Storage, 'getItem'> | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(ADMIN_SESSION_MARKER_KEY) === ADMIN_SESSION_MARKER_VALUE;
  } catch {
    return false;
  }
}

export function isAdminUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('#adminEditorGate, [data-admin-editor]') !== null;
}

function setAdminSessionMarker(storage: SessionStore | null, granted: boolean): boolean {
  if (!storage) return false;
  try {
    if (granted) storage.setItem(ADMIN_SESSION_MARKER_KEY, ADMIN_SESSION_MARKER_VALUE);
    else storage.removeItem(ADMIN_SESSION_MARKER_KEY);
    return true;
  } catch {
    return false;
  }
}

function activateAdminEditorTheme(doc: Document, onAuthorized: () => void): void {
  doc.documentElement.classList.add('admin-editor-authorized');
  doc.body.classList.add('admin-editor-authorized');
  onAuthorized();
}

function deactivateAdminEditorTheme(doc: Document): void {
  doc.documentElement.classList.remove('admin-editor-authorized');
  doc.body.classList.remove('admin-editor-authorized');
}

/**
 * Печатает уведомление в стиле ошибки карты галактики: красная подсветка — для входа,
 * цвет интерфейса — для завершения сеанса. Эффекты (печать, точка, затухание) одинаковы.
 */
function showAdminNotice(doc: Document, message: string, noticeClass: string): void {
  const notice = doc.getElementById('toast');
  if (!(notice instanceof HTMLElement)) return;
  if (adminNoticeTypingTimer !== null) window.clearInterval(adminNoticeTypingTimer);
  if (adminNoticeHideTimer !== null) window.clearTimeout(adminNoticeHideTimer);
  if (adminNoticeFadeTimer !== null) window.clearTimeout(adminNoticeFadeTimer);

  const text = doc.createElement('span');
  const dot = doc.createElement('span');
  dot.className = 'galaxy-error-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = '.';
  notice.replaceChildren(text, dot);
  notice.classList.remove(ADMIN_ACCESS_NOTICE_CLASS, ADMIN_SESSION_END_NOTICE_CLASS);
  notice.classList.add(noticeClass, 'visible');
  notice.classList.remove('is-out', 'is-done');
  const typed = message.slice(0, -1);
  let written = 0;
  adminNoticeTypingTimer = window.setInterval((): void => {
    written += 1;
    text.textContent = typed.slice(0, written);
    if (written >= typed.length) {
      if (adminNoticeTypingTimer !== null) window.clearInterval(adminNoticeTypingTimer);
      adminNoticeTypingTimer = null;
      notice.classList.add('is-done');
    }
  }, ADMIN_NOTICE_TYPING_MS);

  adminNoticeHideTimer = window.setTimeout((): void => {
    notice.classList.add('is-out');
    adminNoticeFadeTimer = window.setTimeout((): void => {
      notice.classList.remove(noticeClass, 'visible', 'is-out', 'is-done');
      notice.replaceChildren();
      adminNoticeFadeTimer = null;
      adminNoticeHideTimer = null;
    }, ADMIN_NOTICE_FADE_MS);
  }, ADMIN_NOTICE_SHOW_MS);
}

/** Снимает служебный признак завершённого сеанса, чтобы он не жил в адресе. */
function takeAdminSessionEndQuery(doc: Document): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  const url = new URL(view.location.href);
  if (url.searchParams.get(ADMIN_SESSION_END_QUERY_PARAM) !== ADMIN_SESSION_END_QUERY_VALUE) return false;
  url.searchParams.delete(ADMIN_SESSION_END_QUERY_PARAM);
  view.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}

function removeAdminAccessQuery(doc: Document): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  const url = new URL(view.location.href);
  if (url.searchParams.get(ADMIN_ACCESS_QUERY_PARAM) !== 'confirmed') return false;
  url.searchParams.delete(ADMIN_ACCESS_QUERY_PARAM);
  view.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}

/** Привязывает публичный демо-барьер: сектор открывает модалку, переход — только после совпадения кода. */
export function bindSectorAdminGate(
  doc: Document = document,
  onAuthorized: () => void = function (): void {},
  scheduleNotice: (show: () => void) => void = function (show: () => void): void { show(); },
): void {
  const gate = doc.getElementById('adminEditorGate');
  const panel = doc.getElementById('adminEditorPanel');
  const form = doc.getElementById('adminGateForm');
  const input = doc.getElementById('adminGateCode');
  const submit = doc.getElementById('adminGateSubmit');
  const error = doc.getElementById('adminGateError');
  const openButton = doc.getElementById('adminGateOpen');
  const endButton = doc.getElementById('adminSessionEnd');
  const destination = form instanceof HTMLFormElement
    ? form.dataset.adminGateDestination?.trim() || ''
    : '';
  const modalGate = gate?.hasAttribute('data-admin-gate-modal') === true;
  if (!(gate instanceof HTMLElement) || (!destination && !(panel instanceof HTMLElement))
    || !(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)
    || !(submit instanceof HTMLButtonElement) || !(error instanceof HTMLElement)) return;

  const attempt = createGateAttemptController();
  const defaultErrorMessage = error.textContent || 'Код не совпадает. Измените ввод, чтобы попробовать снова.';
  let storage: SessionStore | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }

  const showPanel = (): void => {
    gate.hidden = true;
    if (panel instanceof HTMLElement) panel.hidden = false;
    if (endButton instanceof HTMLElement) endButton.hidden = false;
  };
  const closeModal = (returnFocus: boolean): void => {
    gate.hidden = true;
    doc.body.classList.remove('admin-gate-open');
    if (returnFocus && openButton instanceof HTMLButtonElement) openButton.focus();
  };

  /** Выход из демо-режима: снимает отметку вкладки, тему и показывает уведомление цветом интерфейса. */
  const endSession = (): void => {
    setAdminSessionMarker(storage, false);
    deactivateAdminEditorTheme(doc);
    attempt.inputChanged();
    input.value = '';
    input.setAttribute('aria-invalid', 'false');
    error.textContent = defaultErrorMessage;
    error.hidden = true;
    submit.disabled = false;
    if (panel instanceof HTMLElement) panel.hidden = true;
    if (endButton instanceof HTMLElement) endButton.hidden = true;
    gate.hidden = false;

    // Выход возвращает на карту сектора: уведомление печатается уже там.
    const view = doc.defaultView;
    const returnTo = endButton instanceof HTMLElement
      ? endButton.dataset.adminSessionReturn?.trim() || ''
      : '';
    if (view && returnTo) {
      const target = new URL(returnTo, view.location.href);
      target.searchParams.set(ADMIN_SESSION_END_QUERY_PARAM, ADMIN_SESSION_END_QUERY_VALUE);
      view.location.assign(target.href);
      return;
    }
    showAdminNotice(doc, ADMIN_SESSION_END_MESSAGE, ADMIN_SESSION_END_NOTICE_CLASS);
  };
  if (endButton instanceof HTMLButtonElement) endButton.addEventListener('click', endSession);

  form.addEventListener('input', (event: Event): void => {
    if (event.target !== input) return;
    attempt.inputChanged();
    submit.disabled = false;
    error.textContent = defaultErrorMessage;
    error.hidden = true;
    input.setAttribute('aria-invalid', 'false');
  });
  form.addEventListener('submit', (event: SubmitEvent): void => {
    event.preventDefault();
    const result = attempt.submit(input.value);
    if (result === 'locked') return;
    if (result === 'invalid') {
      submit.disabled = true;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      return;
    }

    setAdminSessionMarker(storage, true);

    if (destination) {
      if (!hasAdminSessionMarker(storage)) {
        error.textContent = 'Не удалось подтвердить сессию браузера. Разрешите sessionStorage и попробуйте снова.';
        error.hidden = false;
        return;
      }
      const view = doc.defaultView;
      if (!view) return;
      const target = new URL(destination, view.location.href);
      target.searchParams.set(ADMIN_ACCESS_QUERY_PARAM, 'confirmed');
      view.location.assign(target.href);
      return;
    }

    activateAdminEditorTheme(doc, onAuthorized);
    showPanel();
    showAdminNotice(doc, ADMIN_SUCCESS_MESSAGE, ADMIN_ACCESS_NOTICE_CLASS);
  });

  // Возврат после выхода из сеанса: уведомление печатается уже на карте сектора.
  if (takeAdminSessionEndQuery(doc)) {
    scheduleNotice(function (): void {
      showAdminNotice(doc, ADMIN_SESSION_END_MESSAGE, ADMIN_SESSION_END_NOTICE_CLASS);
    });
  }

  // Отметка уже есть: панель открывается сразу, форма остаётся на страже после выхода.
  if (hasAdminSessionMarker(storage) && !destination) {
    activateAdminEditorTheme(doc, onAuthorized);
    showPanel();
    if (removeAdminAccessQuery(doc)) {
      scheduleNotice(function (): void {
        showAdminNotice(doc, ADMIN_SUCCESS_MESSAGE, ADMIN_ACCESS_NOTICE_CLASS);
      });
    }
    return;
  }

  if (modalGate) {
    gate.hidden = true;
    if (!(openButton instanceof HTMLButtonElement)) return;
    openButton.addEventListener('click', (): void => {
      gate.hidden = false;
      doc.body.classList.add('admin-gate-open');
      input.focus();
    });
    gate.addEventListener('click', (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-admin-gate-close]')) {
        closeModal(true);
      }
    });
    doc.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || gate.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      closeModal(true);
    });
  } else {
    gate.hidden = false;
    if (panel instanceof HTMLElement) panel.hidden = true;
  }
}
