import { dropbox } from './dropbox.js';

/**
 * A provider is a tiny file store:
 *   id, name, configured(), isConnected(), connect(), disconnect(),
 *   read(path) -> { data: Blob, rev } | null,
 *   write(path, data, { rev }) -> newRev   (conditional on rev when given; throws an error that isRevConflict() recognises),
 *   remove(path), isRevConflict(error)
 * OneDrive / Google Drive plug in the same way.
 */
const providers = new Map([[dropbox.id, dropbox]]);

export const registerProvider = provider => providers.set(provider.id, provider);
export const getProvider = id => providers.get(id) ?? null;
export const listProviders = () => [...providers.values()];
