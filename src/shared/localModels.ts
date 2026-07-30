// The curated local models the app offers to pull-and-configure — the "choose a model, we install
// it" list, shared by the first-run card and the models dialog so both stay in step. Deliberately
// short: the 7–9B Q4 sweet spot that runs fully on a modest GPU (~5–6 GB) at usable speed, which
// is exactly the range the harness's rails mode + constrained decoding is tuned for. Ordered by
// what a newcomer should try first.
export interface RecommendedLocalModel {
  /** The Ollama tag pulled and configured, e.g. 'qwen3:8b'. The role id becomes `ollama:<id>`. */
  id: string;
  /** Human label for the button. */
  label: string;
  /** One line under the label — why you'd pick this one. */
  note: string;
  /** Rough download size, shown so nobody starts a 5 GB pull by surprise. */
  size: string;
}

export const RECOMMENDED_LOCAL_MODELS: RecommendedLocalModel[] = [
  { id: 'qwen3:8b', label: 'Qwen3 8B', note: 'strong all-rounder — the best default', size: '~5 GB' },
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B', note: 'reliable and widely supported', size: '~5 GB' },
  { id: 'mistral:7b', label: 'Mistral 7B', note: 'lighter and faster, a touch weaker', size: '~4 GB' },
];
