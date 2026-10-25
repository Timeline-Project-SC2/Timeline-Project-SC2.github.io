export type FieldStyle = 'nebula' | 'tactical';

export interface FieldPalette {
  readonly id: FieldStyle;
  readonly background: readonly [number, number, number];
  readonly dust: readonly [number, number, number];
  readonly core: readonly [number, number, number];
  readonly rim: readonly [number, number, number];
  readonly densityStops: readonly number[];
}

export interface SectorFieldState {
  readonly view: { readonly scale: number; readonly tx: number; readonly ty: number };
  readonly viewport: { readonly w: number; readonly h: number };
  readonly dpr: number;
  readonly mapSize: number;
}

export interface SectorField {
  readonly style: FieldStyle;
  readonly backend: 'webgl2' | 'cpu';
  renderField(state: SectorFieldState): void;
  renderToImageData(state: SectorFieldState): ImageData;
  dispose(): void;
}

export const FIELD_SEED_TEXT = 'KP';
export const FIELD_PALETTES: readonly FieldPalette[] = [];

export function hashSeed(text: string): number {
  void text;
  return 0;
}

export function createSectorField(
  canvas: HTMLCanvasElement | null,
  opts?: { readonly style?: FieldStyle },
): SectorField {
  void canvas;
  const style = opts?.style === 'tactical' ? 'tactical' : 'nebula';
  return {
    style,
    backend: 'cpu',
    renderField(): void {},
    renderToImageData(state: SectorFieldState): ImageData {
      const width = Math.max(1, Math.floor(state.viewport.w * state.dpr));
      const height = Math.max(1, Math.floor(state.viewport.h * state.dpr));
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 3; index < data.length; index += 4) data[index] = 255;
      return { width, height, data, colorSpace: 'srgb' } as ImageData;
    },
    dispose(): void {},
  };
}
