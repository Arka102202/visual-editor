// What Preview hears from the extension about the app's calls and fakes (a part of ToMap, named for Preview).

import type { ToMap } from '../mapMessages';

export type CardNetwork = Extract<ToMap, { type: 'calls' } | { type: 'fakes' }>;
