import { catalogueModel } from '@/lib/config/provider-presets';
import {
  getCodexNativeImageProvider,
  getCodexNativeServerProvider,
} from '@/lib/server/codex/server-provider';
import type { ModelSettingsView } from './settings';

/** Live account catalogue is response data, never persisted workspace settings. */
export async function withCodexModelSettings(view: ModelSettingsView): Promise<ModelSettingsView> {
  const text = await getCodexNativeServerProvider().catch(() => null);
  // Text discovery can refresh or clear credentials; read image availability last.
  const image = await getCodexNativeImageProvider().catch(() => null);
  const chatModels = (text?.modelCatalog ?? []).map((model) =>
    catalogueModel('chat', 'openai-codex', model.id, model),
  );
  const imageModels = (image?.models ?? []).map((id) => catalogueModel('image', 'codex-image', id));
  const capabilities = (
    entry: ModelSettingsView['providers'][number] | ModelSettingsView['presets'][number],
  ) => {
    const next = { ...entry.capabilities };
    if (next.chat?.registryId === 'openai-codex') next.chat = { ...next.chat, models: chatModels };
    if (next.image?.registryId === 'codex-image')
      next.image = { ...next.image, models: imageModels };
    return next;
  };
  return {
    ...view,
    slots: view.slots.map((slot) => {
      const target = slot.effective;
      const unavailable =
        target.status === 'assigned' &&
        ((target.registryId === 'openai-codex' &&
          !chatModels.some((model) => model.id === target.modelId)) ||
          (target.registryId === 'codex-image' && !image));
      return unavailable
        ? {
            ...slot,
            effective: { status: 'invalid' as const, message: 'Reconnect Codex to use this model' },
          }
        : slot;
    }),
    presets: view.presets.map((preset) => ({ ...preset, capabilities: capabilities(preset) })),
    providers: view.providers.map((provider) => ({
      ...provider,
      capabilities: capabilities(provider),
      ...(provider.capabilities.chat?.registryId === 'openai-codex' ? { connected: !!text } : {}),
      ...(provider.capabilities.image?.registryId === 'codex-image' ? { connected: !!image } : {}),
    })),
  };
}
