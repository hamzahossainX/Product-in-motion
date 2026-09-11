/**
 * The model-family switch.
 *
 * Three buttons in a radiogroup, a comparison table that highlights the chosen
 * column, and a version counter the scene watches so it can run a real
 * transition rather than swapping geometry on a frame boundary.
 *
 * Keyboard follows the radiogroup pattern — arrows move between options and
 * move the selection with them — because that is what `role="radio"` promises.
 */
import { VARIANTS, type InteractionState } from '../../lib/InteractionState.ts';

const SWITCH_SELECTOR = '.configurator__switch';
const OPTION_SELECTOR = '.configurator__option';
const TABLE_ID = 'configurator-compare';
const SELECTED_CLASS = 'is-selected';
const COLUMN_CLASS = 'is-current-column';

export class ConfiguratorControl {
  private readonly options: HTMLButtonElement[];
  private readonly table: HTMLTableElement | null;
  private readonly state: InteractionState;
  private readonly onClick: (event: Event) => void;
  private readonly onKey: (event: KeyboardEvent) => void;

  constructor(state: InteractionState) {
    this.state = state;
    const group = document.querySelector<HTMLElement>(SWITCH_SELECTOR);
    this.options = [...(group?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR) ?? [])];
    this.table = document.querySelector<HTMLTableElement>(`#${TABLE_ID}`);

    this.onClick = (event) => {
      const index = this.options.indexOf(event.currentTarget as HTMLButtonElement);
      if (index >= 0) this.select(index, false);
    };
    this.onKey = (event) => {
      const index = this.options.indexOf(event.currentTarget as HTMLButtonElement);
      if (index < 0) return;
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      this.select((index + step + this.options.length) % this.options.length, true);
    };

    for (const option of this.options) {
      option.addEventListener('click', this.onClick);
      option.addEventListener('keydown', this.onKey);
    }
    this.select(0, false);
  }

  select(index: number, focus: boolean): void {
    const clamped = Math.max(0, Math.min(this.options.length - 1, index));
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i]!;
      const selected = i === clamped;
      option.classList.toggle(SELECTED_CLASS, selected);
      option.setAttribute('aria-checked', selected ? 'true' : 'false');
      // Roving tabindex: one stop for the whole group, as a radiogroup should.
      option.tabIndex = selected ? 0 : -1;
      if (selected && focus) option.focus();
    }
    this.highlightColumn(clamped);

    if (this.state.variant !== clamped) {
      this.state.variant = clamped;
      this.state.variantVersion++;
    }
  }

  /** The table is the other half of the interaction: the 3D and the spec sheet
   *  have to agree, or the switch reads as decoration. */
  private highlightColumn(index: number): void {
    const rows = this.table?.querySelectorAll('tr') ?? [];
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      for (let i = 0; i < cells.length; i++) {
        // Column 0 is the row label, so the variants start at 1.
        cells[i]!.classList.toggle(COLUMN_CLASS, i === index + 1);
      }
    }
  }

  get variantName(): string {
    return VARIANTS[this.state.variant]?.name ?? '';
  }

  destroy(): void {
    for (const option of this.options) {
      option.removeEventListener('click', this.onClick);
      option.removeEventListener('keydown', this.onKey);
    }
  }
}
