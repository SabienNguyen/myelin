// First-party client runtime core (own-harness phase E1). Built and tested against the current
// wire format; nothing in the live app imports it until E2 swaps runtime.tsx over.
export { blockOutputsComplete } from './blockOutputsComplete.js';
export { ChatStore, type ChatState, type ChatStoreOptions } from './chatStore.js';
export { consumeChatStream, type ChatRequestBody, type ConsumeChatStreamOptions } from './streamConsumer.js';
export { uiMessageToThreadMessage, useChatCoreRuntime, type ChatCoreRuntimeOptions } from './runtimeAdapter.js';
