export interface GenerateRequest {
  prompt: string;
  width: number;
  height: number;
  count: number;
  transparent: boolean;
  /** Absolute paths of style reference images, already checked against the read sandbox. */
  references: string[];
}

export interface EditRequest extends GenerateRequest {
  /** Absolute path of the image to change, already checked against the read sandbox. */
  image: string;
}

export interface SetItem {
  name: string;
  prompt: string;
}

export interface SetRequest {
  /** Description shared by every image in the set. */
  style: string;
  items: SetItem[];
  width: number;
  height: number;
  transparent: boolean;
  references: string[];
}

export interface RawImage {
  data: Buffer;
  mimeType: "image/png";
  /** Model or variant that produced the image, recorded in the sidecar. */
  model: string;
  /** For sets: index of the item this image was made for, when the provider knows it. */
  item?: number;
}

export type ProgressFn = (message: string) => void;

export interface Provider {
  name: string;
  capabilities: { edit: boolean; references: boolean; transparent: boolean; sizes: string[] };
  generate(req: GenerateRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
  edit?(req: EditRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
  /** Makes a matching set in one go. Without it, sets are made one item at a time. */
  generateSet?(req: SetRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
}
