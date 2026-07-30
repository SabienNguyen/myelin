// First-party client runtime core (own-harness phase E): stream consumer, chat store, and the
// assistant-ui external-store adapter runtime.tsx mounts. Speaks the current wire format.
export { blockOutputsComplete } from './blockOutputsComplete.js';
export { ChatStore, type ChatState, type ChatStoreOptions } from './chatStore.js';
export { consumeChatStream, type ChatRequestBody, type ConsumeChatStreamOptions } from './streamConsumer.js';
export { uiMessageToThreadMessage, useChatCoreRuntime, type ChatCoreRuntimeOptions } from './runtimeAdapter.js';
