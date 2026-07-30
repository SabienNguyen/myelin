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
