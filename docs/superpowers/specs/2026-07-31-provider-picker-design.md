# Provider picker: choose a provider, not a URL

Configuring a hosted model today means knowing things the app already knows. The models dialog
offers one free-text `openai-compatible base url` field with an OpenRouter placeholder, so pointing
a role at OpenAI means going to find `https://api.openai.com/v1` yourself, and pointing it at a
specific model means knowing that model's exact id from memory.

Both are avoidable. The app already ships a curated list for local models
(`RECOMMENDED_LOCAL_MODELS` → the "pick one and we install it" rows). Providers get the same
treatment.

## 1. The provider list

New `src/shared/providers.ts`, shaped like `localModels.ts`:

```ts
export interface Provider {
  id: string;          // 'openrouter'
  label: string;       // 'OpenRouter'
  baseUrl: string;     // 'https://openrouter.ai/api/v1'
  note: string;        // one line: why you'd pick this
  keysUrl?: string;    // where to get an API key
}
```

Entries, ordered by what a newcomer should try first:

| label | baseUrl | note |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | one key, most models from every vendor |
| OpenAI | `https://api.openai.com/v1` | GPT-5.6 Sol / Terra / Luna direct |
| Nous Portal | `https://inference-api.nousresearch.com/v1` | Hermes models |
| LiteLLM | `http://localhost:4000/v1` | your own proxy, any upstream |

Deliberately short, same discipline as the local list. This is a menu, not a directory — a provider
earns a row by being one someone here would plausibly use.

## 2. The dialog

A `provider` `<select>` sits directly above the existing `openai-compatible base url` field.

- Selecting a provider writes its `baseUrl` into the base-url field. The field stays editable and
  stays the source of truth — the select is a filler, not a new setting. Nothing new is persisted:
  `OPENAI_COMPAT_BASE_URL` remains the only saved value.
- The select shows `Custom…` when the current base URL matches no known provider, and picking
  `Custom…` clears the field for typing. **`Custom…` stays**: self-hosted and proxied endpoints are
  a real configuration this app supports, and removing the escape hatch to shorten a menu would
  break them.
- The provider's `note` renders beside it, and `keysUrl` renders as a "get a key" link, matching how
  `LocalModelGetter` pairs an install link with its one-liner.

Once a key is saved, the existing `/models` probe already lists that provider's real models as
`openai:…` ids — so after this change the flow is: pick provider → paste key → pick a model from a
list. No URL typed, no id remembered.

## 3. The dropdown that shows one model

Fixed in the same change, because a provider picker that populates a list you cannot see is
pointless.

The role fields are `<input list="model-id-list">`. The datalist genuinely holds every id (verified
live: 22 options, 16 of them discovered), but browsers filter datalist suggestions to what is
already typed — and the field is pre-filled with the role's current model, so exactly one suggestion
survives. The reported symptom, "I only see one model", is that filter.

Fix: **clear the input on focus, restore on blur if the learner typed nothing.** The datalist then
opens against an empty field and offers everything; a field left untouched keeps its value. Free
text still works, which the `openai:` route needs.

Rejected alternatives: select-all-on-focus (the filter still applies to the selected text, so it
does not fix the symptom); a full ARIA combobox (correct, and the right thing if this field grows
richer, but it is a much larger change for the same outcome here).

The existing "installed locally" chips stay — they already list every ollama tag and fill the
last-focused role, and they remain the fastest path for local models.

## 4. Out of scope

- No provider-specific auth beyond the single key field that exists today.
- No per-provider model curation: discovery already asks the endpoint what it serves.
- Anthropic is untouched — it is the plain-id route with its own key field, already in the dialog.

## 5. Tests

- `providers.ts` is data; it gets no test of its own.
- Client: selecting a provider fills the base-url field with its exact URL; the select reads
  `Custom…` for an unrecognised URL; picking `Custom…` clears the field; the "get a key" link points
  at `keysUrl`.
- Client: a role input pre-filled with a model empties on focus and restores on blur when untouched,
  and keeps a typed value on blur when changed.
- No server change, so no server test: the saved shape (`OPENAI_COMPAT_BASE_URL`) is unchanged and
  its existing route tests still cover it.
