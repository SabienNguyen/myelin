import { useEffect, useState } from 'react';
import { MoonIcon as Moon } from '@phosphor-icons/react/dist/csr/Moon';
import { SunIcon as Sun } from '@phosphor-icons/react/dist/csr/Sun';
import { chooseScheme, currentScheme, onSchemeChange } from '../lib/theme.js';

/** Flips between light and dark. Shows the scheme it switches TO, the way a light switch does, and
 *  follows an OS change until the learner has clicked it once. */
export function ThemeToggle() {
  const [scheme, setScheme] = useState(currentScheme);
  useEffect(() => onSchemeChange(() => setScheme(currentScheme())), []);
  const next = scheme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="ghost-btn"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => chooseScheme(next)}
    >
      {next === 'light' ? <Sun size={16} weight="duotone" aria-hidden="true" /> : <Moon size={16} weight="duotone" aria-hidden="true" />}
    </button>
  );
}
