import type { NextRequest } from 'next/server';
import type { ImageGenerationResult } from '@/lib/media/types';
import type { StepContext } from '@/lib/server/generation/steps/context';
import type { ImageInput } from '@/lib/server/generation/steps/image';
import type { MediaConnection } from '@/lib/server/model-config/media';
import { codexImageProvider } from '@/lib/server/providers/codex-image';

/** Server-account adapters that do not accept user API keys or endpoints. */
export interface NativeImageProvider {
  requestConnection(request: NextRequest): MediaConnection;
  generate(input: ImageInput, ctx: StepContext): Promise<ImageGenerationResult>;
  verifyConnection(): Promise<Response>;
  handlesError(error: unknown): boolean;
  errorResponse(error: unknown): Response;
}

const NATIVE_IMAGE_PROVIDERS: Record<string, NativeImageProvider> = {
  'codex-image': codexImageProvider,
};

export function nativeImageProviderFor(providerId: string): NativeImageProvider | undefined {
  return NATIVE_IMAGE_PROVIDERS[providerId];
}

export function nativeImageErrorResponse(error: unknown): Response | undefined {
  return Object.values(NATIVE_IMAGE_PROVIDERS)
    .find((adapter) => adapter.handlesError(error))
    ?.errorResponse(error);
}
