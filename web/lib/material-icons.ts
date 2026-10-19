// Original Google Material Symbols SVGs, stored locally. See assets/material/README.md.
export function materialIconUrl(name: string) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid Material icon name');
  return `assets/material/${name}.svg`;
}
export function materialIcon(name: string) {
  return `<span class="material-icon" aria-hidden="true" style="mask-image:url('${materialIconUrl(name)}')"></span>`;
}

