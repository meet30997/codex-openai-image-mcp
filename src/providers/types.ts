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

export interface RawImage {
  data: Buffer;
  mimeType: "image/png";
  /** Model or variant that produced the image, recorded in the sidecar. */
  model: string;
}

export type ProgressFn = (message: string) => void;

export interface Provider {
  name: string;
  capabilities: { edit: boolean; references: boolean; transparent: boolean; sizes: string[] };
  generate(req: GenerateRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
  edit?(req: EditRequest, signal: AbortSignal, progress: ProgressFn): Promise<RawImage[]>;
}
