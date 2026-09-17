import { useRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { flushSync } from 'react-dom';
import { SymbolKeyboard } from './SymbolKeyboard.js';

type Props = (InputHTMLAttributes<HTMLInputElement> & { multiline?: false })
  | (TextareaHTMLAttributes<HTMLTextAreaElement> & { multiline: true });

/** Native input semantics, including FormData and React onChange; insert at the saved selection. */
export function SymbolInput(props: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const insert = (symbol: string) => {
    const el = props.multiline ? textarea.current : input.current;
    if (!el || el.disabled || el.readOnly) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const value = el.value.slice(0, start) + symbol + el.value.slice(end);
    if (el.maxLength >= 0 && value.length > el.maxLength) return;
    // Use the native setter so React's value tracker observes a real edit on the input event.
    const proto = props.multiline ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    el.focus();
    el.setSelectionRange(start + symbol.length, start + symbol.length);
  };
  let field;
  if (props.multiline) {
    const { multiline: _, ...rest } = props;
    field = <textarea {...rest} ref={textarea} />;
  } else {
    const { multiline: _, ...rest } = props;
    field = <input {...rest} ref={input} />;
  }
  return <div className="symbol-input">
    {field}
    <SymbolKeyboard disabled={props.disabled || props.readOnly} onInsert={insert} />
  </div>;
}
