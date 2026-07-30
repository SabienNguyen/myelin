// Public surface of the first-party model layer. sse.ts is an internal detail of the adapters.
export * from './types.js';
export { anthropicModel, type AnthropicModelOptions } from './anthropic.js';
export { openaiCompatModel, type OpenAICompatModelOptions } from './openaiCompat.js';
export {
  runLoop,
  type LoopEvent, type LoopResult, type LoopStep, type LoopTool, type RunLoopOptions,
} from './loop.js';
export {
  generateText, generateStructured,
  type GenerateTextOptions, type GenerateStructuredOptions,
} from './generate.js';
export {
  createUiStream, generateMessageId, uiMessagesToChatMessages,
  type CreateUiStreamOptions, type UiChunk, type UiStreamWriter,
} from './wire.js';
export {
  spawnMcpServer,
  type McpConnection, type McpToolDecl, type McpToolResult, type SpawnMcpServerOptions,
} from './mcpClient.js';
