import { useEffect, useState } from 'react';
import { MoonIcon as Moon } from '@phosphor-icons/react/dist/csr/Moon';
import { SunIcon as Sun } from '@phosphor-icons/react/dist/csr/Sun';
import { chooseScheme, currentScheme, onSchemeChange } from '../lib/theme.js';

/** Light or dark, as two pressed-or-not buttons in the settings menu. Follows an OS change until
 *  the learner has chosen once (theme.ts). */
export function ThemeChoice() {
  const [scheme, setScheme] = useState(currentScheme);
  useEffect(() => onSchemeChange(() => setScheme(currentScheme())), []);
  return (
    <span className="theme-choice" role="group" aria-label="Theme">
      {(['light', 'dark'] as const).map((s) => (
        <button key={s} type="button" aria-pressed={scheme === s} onClick={() => chooseScheme(s)}>
          {s === 'light' ? <Sun size={14} weight="duotone" aria-hidden="true" /> : <Moon size={14} weight="duotone" aria-hidden="true" />}
          {s === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </span>
  );
}
