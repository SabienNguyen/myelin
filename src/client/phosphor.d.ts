// @phosphor-icons/react ships ESM .d.ts files with extensionless relative imports, which
// "moduleResolution": "NodeNext" refuses to resolve — every icon re-export silently vanishes
// from the package's type surface (runtime is fine; Vite resolves the JS). Augment the module
// with the handful of icons the app uses instead of relaxing the resolver for the whole repo.
import type { ComponentType } from 'react';

declare module '@phosphor-icons/react' {
  interface PhosphorIconProps {
    size?: number | string;
    weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
    color?: string;
    className?: string;
    mirrored?: boolean;
  }
  export const BookOpenTextIcon: ComponentType<PhosphorIconProps>;
  export const BrainIcon: ComponentType<PhosphorIconProps>;
  export const UserCircleIcon: ComponentType<PhosphorIconProps>;
  export const CheckIcon: ComponentType<PhosphorIconProps>;
  export const SigmaIcon: ComponentType<PhosphorIconProps>;
  export const ListChecksIcon: ComponentType<PhosphorIconProps>;
  export const PenNibIcon: ComponentType<PhosphorIconProps>;
  export const ClockCounterClockwiseIcon: ComponentType<PhosphorIconProps>;
  export const PencilSimpleIcon: ComponentType<PhosphorIconProps>;
}
