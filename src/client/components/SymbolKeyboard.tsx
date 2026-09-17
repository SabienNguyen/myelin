import { useId, useState } from 'react';

/** Unicode, not LaTeX: these characters can be read and edited in ordinary text answers. */
export const SYMBOLS = [
  ['λ', 'lambda'], ['ρ', 'rho'], ['μ', 'mu'], ['α', 'alpha'], ['β', 'beta'],
  ['γ', 'gamma'], ['δ', 'delta'], ['Δ', 'capital delta'], ['θ', 'theta'], ['π', 'pi'],
  ['σ', 'sigma'], ['Σ', 'capital sigma'], ['ω', 'omega'], ['Ω', 'capital omega'],
  ['ε', 'epsilon'], ['τ', 'tau'], ['φ', 'phi'],
  ['×', 'multiply'], ['÷', 'divide'], ['·', 'dot product'], ['−', 'minus'],
  ['±', 'plus or minus'], ['=', 'equals'], ['≠', 'not equal'], ['≈', 'approximately equal'],
  ['≤', 'less than or equal'], ['≥', 'greater than or equal'], ['∞', 'infinity'],
  ['√', 'square root'], ['∑', 'sum'], ['∫', 'integral'], ['∂', 'partial derivative'],
  ['∇', 'gradient'], ['→', 'right arrow'], ['⇒', 'implies'], ['∈', 'element of'],
  ['²', 'squared'], ['³', 'cubed'], ['⁻¹', 'inverse exponent'],
  ['₀', 'subscript zero'], ['₁', 'subscript one'], ['₂', 'subscript two'], ['°', 'degrees'],
].map(([symbol, name]) => ({ symbol, name }));

export function SymbolKeyboard({ onInsert, disabled = false }: {
  onInsert: (symbol: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="symbol-keyboard">
      <button type="button" className="symbol-toggle" aria-expanded={open} aria-controls={id}
        disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        Math symbols
      </button>
      {open && <div id={id} className="symbol-panel">
        <p>click to insert at your cursor</p>
        <div className="symbol-keys" role="group" aria-label="Math symbols"
          onKeyDown={(e) => {
            const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
            const index = buttons.indexOf(e.target as HTMLButtonElement);
            if (index < 0) return;
            const next = e.key === 'ArrowRight' ? (index + 1) % buttons.length
              : e.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
                : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
            if (next !== null) { e.preventDefault(); buttons[next].focus(); }
          }}>
          {SYMBOLS.map(({ symbol, name }) => <button key={name} type="button"
            aria-label={`${symbol} — ${name}`} title={name} disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(symbol)}>{symbol}</button>)}
        </div>
      </div>}
    </div>
  );
}
