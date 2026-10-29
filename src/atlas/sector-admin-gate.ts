/** Публичный тестовый барьер интерфейса, не средство авторизации или защиты данных. */
export const PUBLIC_TEST_CODE = 'KP-ADM-DEMO-27';
export const ADMIN_SESSION_MARKER_KEY = 'timeline-admin-demo-access';
const ADMIN_SESSION_MARKER_VALUE = 'granted';

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

/** Привязывает только демо-форму; никаких данных или изменений не отправляется. */
export function bindSectorAdminGate(doc: Document = document): void {
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
    showPanel();
  });
}
