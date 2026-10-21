/* Контракт planet_generation для браузерного рантайма (CR-01 PR 2).
   -------------------------------------------------------------------------
   Единственный источник истины — src/contracts/planet-generation-contract.json.
   Этот модуль не хранит второй копии схемы или чисел пресетов: он читает тот
   же JSON, что tools/planet_generation.py, раскрывает эффективный профиль,
   квантует числа по NUMBER_PRECISION (Decimal ROUND_HALF_UP), строит
   канонический географический манифест и считает PG1 точно как Python.

   Vite-сборка инлайнит импортированный JSON в опубликованный hashed JS, поэтому
   браузеру и worker не нужен отдельный runtime-fetch контракта. */

import contractData from "../../src/contracts/planet-generation-contract.json" with { type: "json" };

export interface PlanetPresetContract {
  readonly description: string;
  readonly palette_id: string;
  readonly expected_surface_classes: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export interface PlanetGenerationContractData {
  readonly contract_id: string;
  readonly manifest_format: string;
  readonly schema_version: string;
  readonly fields: readonly string[];
  readonly profile_statuses: readonly string[];
  readonly surface_classes: readonly string[];
  readonly known_place_types: readonly string[];
  readonly default_versions: Readonly<Record<string, string>>;
  readonly supported_versions: Readonly<Record<string, readonly string[]>>;
  readonly version_fields: readonly string[];
  readonly geography_number_fields: readonly string[];
  readonly geography_number_field_groups: Readonly<Record<string, readonly string[]>>;
  readonly number_precision: Readonly<Record<string, number>>;
  readonly limits: Readonly<Record<string, string>>;
  readonly default_render: Readonly<Record<string, string>>;
  readonly presets: Readonly<Record<string, PlanetPresetContract>>;
}

export const CONTRACT: PlanetGenerationContractData =
  contractData as unknown as PlanetGenerationContractData;

export const CONTRACT_ID: string = CONTRACT.contract_id;
export const MANIFEST_FORMAT: string = CONTRACT.manifest_format;
export const SCHEMA_VERSION: string = CONTRACT.schema_version;
export const FIELDS: readonly string[] = CONTRACT.fields;
export const PROFILE_STATUSES: readonly string[] = CONTRACT.profile_statuses;
export const SURFACE_CLASSES: readonly string[] = CONTRACT.surface_classes;
export const DEFAULT_VERSIONS: Readonly<Record<string, string>> = CONTRACT.default_versions;
export const SUPPORTED_VERSIONS: Readonly<Record<string, readonly string[]>> =
  CONTRACT.supported_versions;
export const VERSION_FIELDS: readonly string[] = CONTRACT.version_fields;
export const GEOGRAPHY_NUMBER_FIELDS: readonly string[] = CONTRACT.geography_number_fields;
export const NUMBER_PRECISION: Readonly<Record<string, number>> = CONTRACT.number_precision;
export const PRESETS: Readonly<Record<string, PlanetPresetContract>> = CONTRACT.presets;

const DECIMAL_RE = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const SEED_RE = /^[0-9a-fA-F]{16}$/;
const GENERATION_KEY_RE = /^PG1-[A-Z2-7]{26}$/;

/** Десятичное число после канонического квантования контракта.
 *  Хранит именно текст, который Python записывает в canonical JSON:
 *  обычное JS-число потеряло бы trailing zeros и точность Decimal. */
export class CanonicalDecimal {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  toString(): string {
    return this.text;
  }

  valueOf(): number {
    return Number(this.text);
  }

  toJSON(): number {
    return Number(this.text);
  }
}

export type PlanetGenerationProfileInput = Readonly<Record<string, unknown>>;

export interface EffectivePlanetGenerationProfile {
  readonly [field: string]: string | number | CanonicalDecimal | null;
  readonly place_id: string;
  readonly profile_status: string;
  readonly profile_revision: number;
  readonly preset_id: string;
  readonly surface_class: string;
  readonly radius_km: CanonicalDecimal | null;
  readonly axial_tilt_deg: CanonicalDecimal;
  readonly rotation_period_hours: CanonicalDecimal;
  readonly palette_id: string;
  readonly master_seed_hex: string;
  readonly grid_version: string;
  readonly noise_version: string;
  readonly geography_version: string;
  readonly preset_version: string;
  readonly generation_key: string;
  readonly approved_by: string;
  readonly approved_at: string;
  readonly notes_admin: string;
}

export interface GeographyManifest {
  readonly [field: string]: string | number | CanonicalDecimal;
  readonly manifest_format: string;
  readonly schema_version: string;
  readonly place_id: string;
  readonly profile_revision: number;
  readonly preset_id: string;
  readonly surface_class: string;
  readonly radius_km: CanonicalDecimal;
  readonly master_seed_hex: string;
  readonly grid_version: string;
  readonly noise_version: string;
  readonly geography_version: string;
  readonly preset_version: string;
}

export interface GenerationKeyVerification {
  readonly ok: boolean;
  readonly applicable: boolean;
  readonly status: string;
  readonly expectedKey: string | null;
  readonly actualKey: string | null;
  readonly reason: string | null;
}

export function toCamelCaseKey(field: string): string {
  return field.replace(/_([a-z0-9])/g, (_match: string, letter: string) => letter.toUpperCase());
}

export function getPreset(presetId: string): PlanetPresetContract | undefined {
  return PRESETS[presetId];
}

/** Числовые значения пресета для JS-генератора и bench-инструментов.
 *  Источник — только CONTRACT.presets[*].values канонического JSON. */
export function getPresetGeographyValues(presetId: string): Record<string, number> {
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`Неизвестный preset_id: ${presetId}`);
  const values: Record<string, number> = {};
  for (const field of GEOGRAPHY_NUMBER_FIELDS) {
    const raw = preset.values[field];
    if (raw === undefined) throw new Error(`Пресет ${presetId} не содержит поле ${field}`);
    values[field] = Number(raw);
  }
  return values;
}

/** То же раскрытие пресета, но с camelCase-именами runtime-профиля. */
export function getPresetRuntimeValues(presetId: string): Record<string, number> {
  const values: Record<string, number> = {};
  const snakeValues = getPresetGeographyValues(presetId);
  for (const field of GEOGRAPHY_NUMBER_FIELDS) {
    const value = snakeValues[field];
    if (value === undefined) throw new Error(`Пресет ${presetId} не содержит поле ${field}`);
    values[toCamelCaseKey(field)] = value;
  }
  return values;
}

interface ParsedDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

function parseDecimalText(text: string, field: string): ParsedDecimal {
  const match = DECIMAL_RE.exec(text);
  if (!match) throw new Error(`${field}: ожидалось конечное десятичное число, получено ${text}`);
  const sign = match[1] || "";
  const integerPart = match[2] || "";
  const fractionPart = match[3] !== undefined ? match[3] : (match[4] || "");
  const exponentPart = match[5] ? Number.parseInt(match[5], 10) : 0;
  if (!Number.isSafeInteger(exponentPart)) throw new Error(`${field}: слишком большой десятичный порядок`);
  let digits = `${integerPart}${fractionPart}`.replace(/^0+/, "");
  if (digits === "") digits = "0";
  return {
    negative: sign === "-" && digits !== "0",
    digits,
    exponent: exponentPart - fractionPart.length,
  };
}

function incrementDigitString(digits: string): string {
  const chars = digits.split("");
  let index = chars.length - 1;
  while (index >= 0 && chars[index] === "9") {
    chars[index] = "0";
    index -= 1;
  }
  if (index < 0) return `1${chars.join("")}`;
  chars[index] = String(Number(chars[index]) + 1);
  return chars.join("");
}

function formatScaledInteger(negative: boolean, digits: string, precision: number): string {
  const normalized = digits.replace(/^0+/, "") || "0";
  if (normalized === "0") return precision === 0 ? "0" : `0.${"0".repeat(precision)}`;
  const sign = negative ? "-" : "";
  if (precision === 0) return `${sign}${normalized}`;
  const padded = normalized.padStart(precision + 1, "0");
  const split = padded.length - precision;
  return `${sign}${padded.slice(0, split)}.${padded.slice(split)}`;
}

/** Квантовать значение точно как Python Decimal.quantize(..., ROUND_HALF_UP). */
export function quantizeDecimal(field: string, value: unknown): CanonicalDecimal {
  const precision = NUMBER_PRECISION[field];
  if (precision === undefined) throw new Error(`${field}: в контракте нет number_precision`);
  let text: string;
  if (value instanceof CanonicalDecimal) text = value.text;
  else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field}: ожидалось конечное число`);
    text = String(value);
  } else if (typeof value === "string") text = value.trim();
  else throw new Error(`${field}: ожидалось десятичное число`);
  if (text === "") throw new Error(`${field}: пустое число нельзя квантовать`);

  const parsed = parseDecimalText(text, field);
  if (parsed.digits === "0") return new CanonicalDecimal(formatScaledInteger(false, "0", precision));

  const shift = parsed.exponent + precision;
  let scaledDigits: string;
  if (shift >= 0) {
    scaledDigits = `${parsed.digits}${"0".repeat(shift)}`;
  } else {
    const cut = -shift;
    const keptLength = parsed.digits.length - cut;
    let kept = keptLength > 0 ? parsed.digits.slice(0, keptLength) : "0";
    const dropped = keptLength > 0
      ? parsed.digits.slice(keptLength)
      : parsed.digits.padStart(cut, "0");
    // ROUND_HALF_UP для Decimal: ровно половина округляется от нуля, поэтому
    // первая отброшенная цифра 5 уже означает округление вверх по модулю.
    if (dropped.charAt(0) >= "5") kept = incrementDigitString(kept);
    scaledDigits = kept;
  }
  return new CanonicalDecimal(formatScaledInteger(parsed.negative, scaledDigits, precision));
}

const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  place_id: ["placeId", "planetId"],
  profile_status: ["profileStatus", "status"],
  generation_key: ["generationKey"],
};

function readInputField(input: PlanetGenerationProfileInput, field: string): unknown {
  if (Object.prototype.hasOwnProperty.call(input, field)) return input[field];
  const camel = toCamelCaseKey(field);
  if (Object.prototype.hasOwnProperty.call(input, camel)) return input[camel];
  const aliases = FIELD_ALIASES[field] || [];
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(input, alias)) return input[alias];
  }
  return undefined;
}

function inputText(input: PlanetGenerationProfileInput, field: string): string {
  const value = readInputField(input, field);
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function hasInputValue(input: PlanetGenerationProfileInput, field: string): boolean {
  const value = readInputField(input, field);
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function parseProfileRevision(input: PlanetGenerationProfileInput): number {
  const raw = readInputField(input, "profile_revision");
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  const text = inputText(input, "profile_revision");
  if (!/^\d+$/.test(text)) throw new Error("profile_revision должен быть целым числом >= 1");
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("profile_revision должен быть целым числом >= 1");
  }
  return value;
}

/** Раскрыть сырую строку/частичный runtime-профиль в эффективные значения.
 *  Пустые географические поля берутся из пресета канонического JSON, версии —
 *  из default_versions; это тот же порядок раскрытия, что в Python-валидаторе. */
export function expandPlanetGenerationProfile(
  input: PlanetGenerationProfileInput,
): EffectivePlanetGenerationProfile {
  if (!input || typeof input !== "object") throw new Error("Профиль planet_generation должен быть объектом");

  const surfaceClass = inputText(input, "surface_class");
  const presetId = inputText(input, "preset_id");
  const noSurface = surfaceClass === "no_surface";
  const preset = presetId === "" ? undefined : getPreset(presetId);
  if (presetId !== "" && !preset) throw new Error(`Неизвестный preset_id: ${presetId}`);
  if (!preset && !noSurface) throw new Error("preset_id обязателен для раскрытия профиля");

  const effective: Record<string, string | number | CanonicalDecimal | null> = {};
  effective.place_id = inputText(input, "place_id");
  effective.profile_status = inputText(input, "profile_status");
  effective.profile_revision = parseProfileRevision(input);
  effective.preset_id = presetId;
  effective.surface_class = surfaceClass;
  effective.radius_km = hasInputValue(input, "radius_km")
    ? quantizeDecimal("radius_km", readInputField(input, "radius_km"))
    : null;
  effective.axial_tilt_deg = quantizeDecimal(
    "axial_tilt_deg",
    hasInputValue(input, "axial_tilt_deg")
      ? readInputField(input, "axial_tilt_deg")
      : CONTRACT.default_render.axial_tilt_deg,
  );
  effective.rotation_period_hours = quantizeDecimal(
    "rotation_period_hours",
    hasInputValue(input, "rotation_period_hours")
      ? readInputField(input, "rotation_period_hours")
      : CONTRACT.default_render.rotation_period_hours,
  );
  effective.palette_id = inputText(input, "palette_id") || (preset ? preset.palette_id : "planet");
  effective.master_seed_hex = inputText(input, "master_seed_hex").toLowerCase();
  for (const field of VERSION_FIELDS) {
    const fallback = DEFAULT_VERSIONS[field];
    if (fallback === undefined) throw new Error(`В контракте нет default_versions.${field}`);
    effective[field] = inputText(input, field) || fallback;
  }
  effective.generation_key = inputText(input, "generation_key");
  effective.approved_by = inputText(input, "approved_by");
  effective.approved_at = inputText(input, "approved_at");

  for (const field of GEOGRAPHY_NUMBER_FIELDS) {
    if (hasInputValue(input, field)) {
      effective[field] = quantizeDecimal(field, readInputField(input, field));
    } else if (preset) {
      const presetValue = preset.values[field];
      if (presetValue === undefined) throw new Error(`Пресет ${presetId} не содержит поле ${field}`);
      effective[field] = quantizeDecimal(field, presetValue);
    } else {
      effective[field] = null;
    }
  }
  effective.notes_admin = inputText(input, "notes_admin");
  return effective as EffectivePlanetGenerationProfile;
}

function requireManifestText(value: string, field: string): string {
  if (value === "") throw new Error(`${field} обязателен для географического манифеста`);
  return value;
}

export function buildGeographyManifest(
  input: PlanetGenerationProfileInput,
): GeographyManifest {
  const profile = expandPlanetGenerationProfile(input);
  if (profile.surface_class === "no_surface") {
    throw new Error("Для surface_class=no_surface географический манифест и PG1 не строятся");
  }
  requireManifestText(profile.place_id, "place_id");
  requireManifestText(profile.preset_id, "preset_id");
  requireManifestText(profile.surface_class, "surface_class");
  if (!profile.radius_km) throw new Error("radius_km обязателен для географического манифеста");
  if (!SEED_RE.test(profile.master_seed_hex)) {
    throw new Error("master_seed_hex должен содержать ровно 16 hex-цифр");
  }

  // Форма манифеста плоская и байт-в-байт повторяет Python
  // build_geography_manifest: версии и все географические числа лежат на
  // верхнем уровне, без вложенных объектов versions/geography.
  const manifest: Record<string, string | number | CanonicalDecimal> = {
    manifest_format: MANIFEST_FORMAT,
    schema_version: SCHEMA_VERSION,
    place_id: profile.place_id,
    profile_revision: profile.profile_revision,
    preset_id: profile.preset_id,
    surface_class: profile.surface_class,
    radius_km: profile.radius_km,
    master_seed_hex: profile.master_seed_hex,
  };
  for (const field of VERSION_FIELDS) {
    const value = profile[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} обязательна для манифеста`);
    manifest[field] = value;
  }
  for (const field of GEOGRAPHY_NUMBER_FIELDS) {
    const value = profile[field];
    if (!(value instanceof CanonicalDecimal)) throw new Error(`${field} обязателен для географического манифеста`);
    manifest[field] = value;
  }
  return manifest as unknown as GeographyManifest;
}

/** Канонический JSON манифеста: sorted keys, separators `,`/`:` и Decimal
 *  как голые JSON-числа с квантованным текстом — байты совпадают с Python. */
export function canonicalJsonText(value: unknown): string {
  if (value instanceof CanonicalDecimal) return value.text;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Канонический JSON не поддерживает неконечные числа");
    if (!Number.isInteger(value)) {
      throw new Error("Дробные числа канонического JSON должны быть CanonicalDecimal контракта");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonText(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonText(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`Канонический JSON не поддерживает значение типа ${typeof value}`);
}

const SHA256_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Синхронный чистый SHA-256: одинаковый путь в браузере, worker и Node. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const paddedLength = (((data.length + 9 + 63) // 0x80 + 64-bit length
    >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const words = new Int32Array(64);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getInt32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15] || 0;
      const w2 = words[i - 2] || 0;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[i] = ((words[i - 16] || 0) + s0 + (words[i - 7] || 0) + s1) | 0;
    }

    let a = h0; let b = h1; let c = h2; let d = h3;
    let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + (SHA256_CONSTANTS[i] || 0) + (words[i] || 0)) | 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  const state = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < state.length; i += 1) digestView.setInt32(i * 4, state[i] || 0, false);
  return digest;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32NoPadding(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((buffer >>> bits) & 31);
    }
    buffer &= bits === 32 ? 0xffffffff : ((1 << bits) - 1);
  }
  if (bits > 0) output += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return output;
}

export function geographyManifestCanonicalText(input: PlanetGenerationProfileInput): string {
  return canonicalJsonText(buildGeographyManifest(input));
}

export function computeGenerationKey(input: PlanetGenerationProfileInput): string {
  const canonicalText = geographyManifestCanonicalText(input);
  const digest = sha256Bytes(new TextEncoder().encode(canonicalText));
  return `${MANIFEST_FORMAT}-${base32NoPadding(digest.slice(0, 16))}`;
}

/** Проверить frozen-профиль (или любой профиль с заполненным ключом).
 *  Draft без ключа не применим к проверке и не блокирует черновую генерацию. */
export function verifyGenerationKey(
  profile: PlanetGenerationProfileInput,
): GenerationKeyVerification {
  const status = profile && typeof profile === "object" ? inputText(profile, "profile_status") : "";
  const actualKey = profile && typeof profile === "object" ? inputText(profile, "generation_key") : "";
  const applicable = status === "frozen" || actualKey !== "";
  if (!applicable) {
    return {
      ok: true,
      applicable: false,
      status,
      expectedKey: null,
      actualKey: null,
      reason: null,
    };
  }

  let expectedKey: string | null = null;
  try {
    expectedKey = computeGenerationKey(profile);
  } catch (error) {
    return {
      ok: false,
      applicable: true,
      status,
      expectedKey: null,
      actualKey: actualKey || null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (actualKey === "") {
    return {
      ok: false,
      applicable: true,
      status,
      expectedKey,
      actualKey: null,
      reason: "У frozen-профиля отсутствует generation_key",
    };
  }
  if (!GENERATION_KEY_RE.test(actualKey)) {
    return {
      ok: false,
      applicable: true,
      status,
      expectedKey,
      actualKey,
      reason: "generation_key имеет неверный формат PG1",
    };
  }
  const ok = actualKey === expectedKey;
  return {
    ok,
    applicable: true,
    status,
    expectedKey,
    actualKey,
    reason: ok ? null : "generation_key не соответствует эффективному географическому манифесту",
  };
}
