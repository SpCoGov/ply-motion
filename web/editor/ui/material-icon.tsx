import { materialIconUrl } from '../../lib/material-icons.ts';

export function MaterialIcon({ name, size = 18 }: { name: string; size?: number }) {
  return <span className="material-icon" aria-hidden="true" style={{ maskImage: `url('${materialIconUrl(name)}')`, width: size, height: size }} />;
}
