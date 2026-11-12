/* Отправка заявки на свойства точек из редактора в issue-шлюз.
 *
 * Модуль знает только три вещи: адрес шлюза, cookie сессии (её ставит шлюз,
 * браузерный код cookie не читает) и результат. Токен GitHub никогда не
 * покидает Worker; здесь его нет и быть не может.
 *
 * Ключевое правило: «заявка создана» — не «правка применена» и не «сайт
 * обновлён». Ответ шлюза переносится как есть, а неизвестный результат
 * остаётся неизвестным: повтор разрешён только через тот же requestId, и
 * шлюз сам отличит уже созданную Issue от новой.
 */

export type SubmitOutcome =
  | { readonly status: 'created'; readonly number: number; readonly url: string }
  | { readonly status: 'existing'; readonly number: number; readonly url: string }
  /** Не вошли: нужно открыть вход в GitHub и повторить ту же заявку. */
  | { readonly status: 'unauthorized' }
  | { readonly status: 'rejected' }
  | { readonly status: 'invalid' }
  /** Неизвестно, создана ли Issue: повторять только через тот же requestId. */
  | { readonly status: 'unavailable' }
  /** Адрес шлюза не настроен: отправка недоступна на этой сборке. */
  | { readonly status: 'disabled' };

export interface SubmitEnvironment {
  readonly gatewayUrl: string | null;
  /** Origin страницы: шлюз сверяет его и браузер прикладывает его сам. */
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

const TIMEOUT_MS = 20_000;

const publishedRead = (value: unknown): { number: number; url: string } | null => {
  if (value === null || typeof value !== 'object') return null;
  const { number, url } = value as { number?: unknown; url?: unknown };
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof url !== 'string' || !url.startsWith('https://github.com/') || url.length > 2048) return null;
  return { number, url };
};

/**
 * Один запрос без автоматического повтора. `redirect: 'error'` не
 * используется: часть браузеров и workerd реализуют его по-разному, а
 * редирект шлюза здесь в любом случае означает неизвестный результат.
 */
export async function submitPropertyPacket(
  packet: { readonly title: string; readonly body: string; readonly requestId: string },
  environment: SubmitEnvironment,
): Promise<SubmitOutcome> {
  if (environment.gatewayUrl === null || environment.gatewayUrl === '') return { status: 'disabled' };
  let endpoint: URL;
  let gateway: URL;
  try {
    gateway = new URL(environment.gatewayUrl);
    endpoint = new URL('/issues/submit', gateway);
  } catch {
    return { status: 'disabled' };
  }
  // Только https и только на тот же хост, что задан шаблоном; шлюз не может
  // оказаться на самом сайте (тогда cookie ушла бы не туда).
  if (gateway.protocol !== 'https:' || endpoint.origin !== gateway.origin) return { status: 'disabled' };
  if (environment.origin !== '' && endpoint.origin === environment.origin) return { status: 'disabled' };
  const transport = environment.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await transport(endpoint.toString(), {
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
      cache: 'no-store',
      // Шлюз не должен редиректить; если редирект есть, результат неизвестен.
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: packet.title, body: packet.body, requestId: packet.requestId }),
    });
    if (response.status === 401) return { status: 'unauthorized' };
    if (response.status === 403) return { status: 'rejected' };
    if (response.status === 400) return { status: 'invalid' };
    if (response.status !== 200 && response.status !== 201) return { status: 'unavailable' };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: 'unavailable' };
    }
    const read = publishedRead(payload);
    if (read === null) return { status: 'unavailable' };
    const status = (payload as { status?: unknown }).status;
    // Код ответа и статус в теле обязаны совпадать: иначе результат не подтверждён.
    if (response.status === 201 && status === 'created') return { status: 'created', ...read };
    if (response.status === 200 && status === 'existing') return { status: 'existing', ...read };
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Адрес шлюза из шаблона страницы; пустое значение означает «отправка выключена». */
export function readGatewayUrl(meta: Element | null): string | null {
  const value = meta?.getAttribute('content')?.trim() ?? '';
  if (value === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export const SUBMIT_MESSAGES: Readonly<Record<SubmitOutcome['status'], string>> = {
  created: 'Заявка создана. Это не применение правки и не публикация: статус применения проверяется отдельно.',
  existing: 'Такая заявка уже есть: повторно она не создавалась.',
  unauthorized: 'Нужен вход через GitHub. Правки сохранены локально.',
  rejected: 'GitHub отклонил запрос. Проверьте вход и права; повторять автоматически нельзя.',
  invalid: 'Заявка не прошла проверку формата. Обновите предпросмотр.',
  unavailable: 'Результат неизвестен: заявка могла быть создана. Не отправляйте новую — повторите с тем же идентификатором.',
  disabled: 'Отправка на этой сборке не подключена: шлюз не настроен.',
};
