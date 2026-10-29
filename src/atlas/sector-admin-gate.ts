/** Публичный тестовый барьер интерфейса, не средство авторизации или защиты данных. */
export const PUBLIC_TEST_CODE = 'KP-ADM-DEMO-27';
export const ADMIN_SESSION_MARKER_KEY = 'timeline-admin-demo-access';
const ADMIN_SESSION_MARKER_VALUE = 'granted';
const ADMIN_SUCCESS_MESSAGE = 'Доступ Администратора получен. Права расширены.';
const ADMIN_NOTICE_TYPING_MS = 45;
const ADMIN_NOTICE_SHOW_MS = 5000;
const ADMIN_NOTICE_FADE_MS = 400;
let adminNoticeTypingTimer: number | null = null;
let adminNoticeHideTimer: number | null = null;
let adminNoticeFadeTimer: number | null = null;

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

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

function activateAdminEditorTheme(doc: Document, onAuthorized: () => void): void {
  doc.documentElement.classList.add('admin-editor-authorized');
  doc.body.classList.add('admin-editor-authorized');
  onAuthorized();
}

/** Печатает уведомление стилем красной ошибки с карты галактики. */
function showAdminAccessNotice(doc: Document): void {
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
  notice.classList.add('admin-access-notice', 'visible');
  notice.classList.remove('is-out', 'is-done');
  const message = ADMIN_SUCCESS_MESSAGE.slice(0, -1);
  let written = 0;
  adminNoticeTypingTimer = window.setInterval((): void => {
    written += 1;
    text.textContent = message.slice(0, written);
    if (written >= message.length) {
      if (adminNoticeTypingTimer !== null) window.clearInterval(adminNoticeTypingTimer);
      adminNoticeTypingTimer = null;
      notice.classList.add('is-done');
    }
  }, ADMIN_NOTICE_TYPING_MS);

  adminNoticeHideTimer = window.setTimeout((): void => {
    notice.classList.add('is-out');
    adminNoticeFadeTimer = window.setTimeout((): void => {
      notice.classList.remove('admin-access-notice', 'visible', 'is-out', 'is-done');
      notice.replaceChildren();
      adminNoticeFadeTimer = null;
      adminNoticeHideTimer = null;
    }, ADMIN_NOTICE_FADE_MS);
  }, ADMIN_NOTICE_SHOW_MS);
}

/** Привязывает только демо-форму; никаких данных или изменений не отправляется. */
export function bindSectorAdminGate(
  doc: Document = document,
  onAuthorized: () => void = function (): void {},
): void {
  const gate = doc.getElementById('adminEditorGate');
  const panel = doc.getElementById('adminEditorPanel');
  const form = doc.getElementById('adminGateForm');
  const input = doc.getElementById('adminGateCode');
  const submit = doc.getElementById('adminGateSubmit');
  const error = doc.getElementById('adminGateError');
  if (!(gate instanceof HTMLElement) || !(panel instanceof HTMLElement)
    || !(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)
    || !(submit instanceof HTMLButtonElement) || !(error instanceof HTMLElement)) return;

  const attempt = createGateAttemptController();
  let storage: SessionStore | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }

  const showPanel = (): void => {
    gate.hidden = true;
    panel.hidden = false;
  };
  if (hasAdminSessionMarker(storage)) {
    activateAdminEditorTheme(doc, onAuthorized);
    showPanel();
    return;
  }

  panel.hidden = true;
  gate.hidden = false;
  form.addEventListener('input', (event: Event): void => {
    if (event.target !== input) return;
    attempt.inputChanged();
    submit.disabled = false;
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

    try {
      storage?.setItem(ADMIN_SESSION_MARKER_KEY, ADMIN_SESSION_MARKER_VALUE);
    } catch {
      // При недоступном sessionStorage доступ живёт только до закрытия/перезагрузки страницы.
    }
    activateAdminEditorTheme(doc, onAuthorized);
    showPanel();
    showAdminAccessNotice(doc);
  });
}
